import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException
from openai import APIConnectionError, APIStatusError, OpenAI, OpenAIError
from pydantic import BaseModel, Field, model_validator

from .media import (
    MediaProcessingError,
    decode_base64,
    encode_base64,
    process_document,
    process_video,
)

OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.6-luna")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_TIMEOUT_SECONDS = float(os.environ.get("OPENAI_TIMEOUT_SECONDS", "120"))

state: dict[str, object | None] = {"client": None}


def _client(api_key: str) -> OpenAI:
    return OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT_SECONDS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is required")

    state["client"] = _client(OPENAI_API_KEY)
    yield
    state["client"] = None


app = FastAPI(lifespan=lifespan)


class ChatPart(BaseModel):
    kind: Literal["text", "image", "audio", "video", "file"]
    text: str | None = None
    data: str | None = None
    mediaType: str | None = None
    filename: str | None = None

    @model_validator(mode="after")
    def validate_content(self):
        if self.kind == "text":
            if self.text is None or not self.text.strip():
                raise ValueError("Text parts require non-empty text")
            return self

        if self.data is None or not self.data:
            raise ValueError(f"{self.kind} parts require base64 data")

        if self.mediaType is None or not self.mediaType:
            raise ValueError(f"{self.kind} parts require mediaType")

        return self


class ChatMessage(BaseModel):
    role: str
    content: str = ""
    images: list[str] = Field(default_factory=list)
    parts: list[ChatPart] = Field(default_factory=list)


class ChatRequest(BaseModel):
    system: str
    messages: list[ChatMessage]
    maxTokens: int = 80
    temperature: float = 0.9


class DerivedObservation(BaseModel):
    kind: Literal["image", "transcript", "video_frame", "document_text"]
    sourcePart: int
    processor: str
    model: str | None = None
    text: str | None = None
    startMs: int | None = None
    endMs: int | None = None


class TokenUsage(BaseModel):
    inputTokens: int = 0
    cachedInputTokens: int = 0
    outputTokens: int = 0


class ChatResponse(BaseModel):
    content: str
    model: str
    observations: list[DerivedObservation]
    usage: TokenUsage


def _prepare_message(
    message: ChatMessage,
) -> tuple[dict, list[DerivedObservation]]:
    fragments = [message.content] if message.content.strip() else []
    images = [
        (encode_base64(decode_base64(image)), "image/png")
        for image in message.images
    ]
    observations: list[DerivedObservation] = []

    for source_part, part in enumerate(message.parts):
        if part.kind == "text":
            fragments.append(part.text or "")
            continue

        data = decode_base64(part.data or "")
        media_type = part.mediaType or "application/octet-stream"
        filename = part.filename or f"part-{source_part}"

        if part.kind == "image":
            images.append((encode_base64(data), media_type))
            image_number = len(images)
            fragments.append(
                f"[Image {image_number}, ordered content part {source_part}]"
            )
            observations.append(
                DerivedObservation(
                    kind="image",
                    sourcePart=source_part,
                    processor="openai-vision",
                    model=OPENAI_MODEL,
                )
            )
            continue

        if part.kind == "audio":
            raise HTTPException(
                status_code=422,
                detail="Audio input is not supported by the configured OpenAI model",
            )

        if part.kind == "video":
            processed = process_video(data, filename)

            if processed.audio is not None:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Video audio cannot be processed because no audio-capable "
                        "OpenAI model is configured"
                    ),
                )

            frame_labels: list[str] = []

            for timestamp, frame in zip(
                processed.image_timestamps_ms,
                processed.images,
                strict=True,
            ):
                images.append((encode_base64(frame), "image/jpeg"))
                frame_labels.append(
                    f"Image {len(images)} is the frame at {timestamp} ms"
                )
                observations.append(
                    DerivedObservation(
                        kind="video_frame",
                        sourcePart=source_part,
                        processor="ffmpeg",
                        model=OPENAI_MODEL,
                        startMs=timestamp,
                        endMs=timestamp,
                    )
                )

            fragments.append(
                f"[Video ordered content part {source_part}]\n"
                f"{'; '.join(frame_labels)}"
            )
            continue

        processed = process_document(data, media_type, filename)
        fragments.append(
            f"[Document ordered content part {source_part}: {filename}]\n"
            f"{processed.text or '(no extractable text)'}"
        )
        observations.append(
            DerivedObservation(
                kind="document_text",
                sourcePart=source_part,
                processor="format-specific-extractor",
                text=processed.text,
            )
        )

        for page, image in enumerate(processed.images, start=1):
            images.append((encode_base64(image), "image/png"))
            fragments.append(
                f"[Image {len(images)} is page {page} of {filename}]"
            )
            observations.append(
                DerivedObservation(
                    kind="image",
                    sourcePart=source_part,
                    processor="pdftoppm",
                    model=OPENAI_MODEL,
                )
            )

    text = "\n\n".join(fragment for fragment in fragments if fragment)
    content = []

    if text:
        content.append({"type": "input_text", "text": text})

    content.extend(
        {
            "type": "input_image",
            "image_url": f"data:{media_type};base64,{data}",
        }
        for data, media_type in images
    )
    prepared = {
        "role": message.role,
        "content": content,
    }
    return prepared, observations


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "ml",
        "provider": "openai",
        "model": OPENAI_MODEL,
        "inputModalities": ["text", "image", "video", "file"],
        "unsupportedInputModalities": ["audio"],
        "videoAudioSupported": False,
    }


@app.post("/v1/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    client = state["client"]
    if client is None:
        raise HTTPException(status_code=503, detail="ML client is not ready")

    messages = []
    observations: list[DerivedObservation] = []

    try:
        for message in request.messages:
            prepared, derived = _prepare_message(message)
            messages.append(prepared)
            observations.extend(derived)
    except HTTPException:
        raise
    except MediaProcessingError as exception:
        raise HTTPException(status_code=422, detail=str(exception)) from exception
    except Exception as exception:
        raise HTTPException(
            status_code=502,
            detail="A modality processor failed",
        ) from exception

    try:
        response = client.responses.create(
            model=OPENAI_MODEL,
            instructions=request.system,
            input=messages,
            max_output_tokens=request.maxTokens,
            reasoning={"effort": "none"},
            temperature=request.temperature,
            text={"verbosity": "low"},
        )
    except APIStatusError as exception:
        raise HTTPException(
            status_code=429 if exception.status_code == 429 else 502,
            detail=(
                "OpenAI rejected the inference request with HTTP "
                f"{exception.status_code}"
            ),
        ) from exception
    except APIConnectionError as exception:
        raise HTTPException(
            status_code=502,
            detail="OpenAI could not be reached",
        ) from exception
    except OpenAIError as exception:
        raise HTTPException(
            status_code=502,
            detail="OpenAI inference failed",
        ) from exception

    content = response.output_text.strip()
    if not content:
        raise HTTPException(
            status_code=502,
            detail="OpenAI returned an empty response",
        )

    usage = getattr(response, "usage", None)
    input_details = getattr(usage, "input_tokens_details", None)

    return ChatResponse(
        content=content,
        model=OPENAI_MODEL,
        observations=observations,
        usage=TokenUsage(
            inputTokens=getattr(usage, "input_tokens", 0) or 0,
            cachedInputTokens=getattr(input_details, "cached_tokens", 0) or 0,
            outputTokens=getattr(usage, "output_tokens", 0) or 0,
        ),
    )

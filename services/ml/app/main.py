import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException
from ollama import Client, RequestError, ResponseError
from pydantic import BaseModel, Field, model_validator

from .media import (
    MediaProcessingError,
    decode_base64,
    encode_base64,
    process_document,
    process_video,
)

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "https://ollama.com")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma4:31b-cloud")
OLLAMA_API_KEY = os.environ.get("OLLAMA_API_KEY", "")
OLLAMA_TIMEOUT_SECONDS = float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "120"))

state: dict[str, object | None] = {"client": None}


def _client(host: str, api_key: str) -> Client:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    return Client(
        host=host,
        headers=headers,
        timeout=OLLAMA_TIMEOUT_SECONDS,
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    if OLLAMA_HOST.rstrip("/") == "https://ollama.com" and not OLLAMA_API_KEY:
        raise RuntimeError("OLLAMA_API_KEY is required for Ollama Cloud")

    state["client"] = _client(OLLAMA_HOST, OLLAMA_API_KEY)
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


class ChatResponse(BaseModel):
    content: str
    model: str
    observations: list[DerivedObservation]


def _prepare_message(
    message: ChatMessage,
) -> tuple[dict, list[DerivedObservation]]:
    fragments = [message.content] if message.content.strip() else []
    images = [encode_base64(decode_base64(image)) for image in message.images]
    observations: list[DerivedObservation] = []

    for source_part, part in enumerate(message.parts):
        if part.kind == "text":
            fragments.append(part.text or "")
            continue

        data = decode_base64(part.data or "")
        media_type = part.mediaType or "application/octet-stream"
        filename = part.filename or f"part-{source_part}"

        if part.kind == "image":
            images.append(encode_base64(data))
            image_number = len(images)
            fragments.append(
                f"[Image {image_number}, ordered content part {source_part}]"
            )
            observations.append(
                DerivedObservation(
                    kind="image",
                    sourcePart=source_part,
                    processor="ollama-cloud-multimodal",
                    model=OLLAMA_MODEL,
                )
            )
            continue

        if part.kind == "audio":
            raise HTTPException(
                status_code=422,
                detail="No audio-capable model is available through Ollama Cloud",
            )

        if part.kind == "video":
            processed = process_video(data, filename)

            if processed.audio is not None:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Video audio cannot be processed because no audio-capable "
                        "model is available through Ollama Cloud"
                    ),
                )

            frame_labels: list[str] = []

            for timestamp, frame in zip(
                processed.image_timestamps_ms,
                processed.images,
                strict=True,
            ):
                images.append(encode_base64(frame))
                frame_labels.append(
                    f"Image {len(images)} is the frame at {timestamp} ms"
                )
                observations.append(
                    DerivedObservation(
                        kind="video_frame",
                        sourcePart=source_part,
                        processor="ffmpeg",
                        model=OLLAMA_MODEL,
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
            images.append(encode_base64(image))
            fragments.append(
                f"[Image {len(images)} is page {page} of {filename}]"
            )
            observations.append(
                DerivedObservation(
                    kind="image",
                    sourcePart=source_part,
                    processor="pdftoppm",
                    model=OLLAMA_MODEL,
                )
            )

    prepared = {
        "role": message.role,
        "content": "\n\n".join(fragment for fragment in fragments if fragment),
        **({"images": images} if images else {}),
    }
    return prepared, observations


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "ml",
        "provider": "ollama-cloud",
        "model": OLLAMA_MODEL,
        "inputModalities": ["text", "image", "video", "file"],
        "unsupportedInputModalities": ["audio"],
        "videoAudioSupported": False,
    }


@app.post("/v1/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    client = state["client"]
    if client is None:
        raise HTTPException(status_code=503, detail="ML client is not ready")

    messages = [{"role": "system", "content": request.system}]
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
        response = client.chat(
            model=OLLAMA_MODEL,
            messages=messages,
            stream=False,
            think=False,
            options={
                "num_predict": request.maxTokens,
                "temperature": request.temperature,
                "top_p": 0.95,
                "repeat_penalty": 1.1,
            },
        )
    except ResponseError as exception:
        raise HTTPException(
            status_code=502,
            detail=(
                "Ollama Cloud rejected the inference request with HTTP "
                f"{exception.status_code}"
            ),
        ) from exception
    except RequestError as exception:
        raise HTTPException(
            status_code=502,
            detail="Ollama Cloud could not be reached",
        ) from exception

    content = response.message.content.strip()
    if not content:
        raise HTTPException(
            status_code=502,
            detail="Ollama Cloud returned an empty response",
        )

    return ChatResponse(
        content=content,
        model=OLLAMA_MODEL,
        observations=observations,
    )

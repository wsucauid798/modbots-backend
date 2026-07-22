import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from .media import (
    MediaProcessingError,
    decode_base64,
    encode_base64,
    process_document,
    process_video,
)

MODEL_URL = os.environ.get(
    "MODEL_URL",
    "http://model-runner.docker.internal/engines/v1",
)
MODEL_ID = os.environ.get("MODEL_ID", "ai/gemma4")
INFERENCE_TIMEOUT_SECONDS = float(
    os.environ.get("INFERENCE_TIMEOUT_SECONDS", "600")
)

state: dict[str, httpx.AsyncClient | None] = {"client": None}


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with httpx.AsyncClient(
        base_url=f"{MODEL_URL.rstrip('/')}/",
        timeout=INFERENCE_TIMEOUT_SECONDS,
    ) as client:
        state["client"] = client
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
    role: Literal["user", "assistant", "system"]
    content: str = ""
    images: list[str] = Field(default_factory=list)
    parts: list[ChatPart] = Field(default_factory=list)


class ChatRequest(BaseModel):
    system: str
    messages: list[ChatMessage]
    maxTokens: int = Field(default=80, ge=1, le=4096)
    temperature: float = Field(default=0.9, ge=0, le=2)


class DerivedObservation(BaseModel):
    kind: Literal["image", "audio", "video_frame", "document_text"]
    sourcePart: int
    processor: str
    text: str | None = None
    startMs: int | None = None
    endMs: int | None = None


class ChatResponse(BaseModel):
    content: str
    model: str
    observations: list[DerivedObservation]


def _data_url(data: str, media_type: str) -> str:
    encoded = encode_base64(decode_base64(data))
    return f"data:{media_type};base64,{encoded}"


def _audio_format(media_type: str, filename: str) -> str:
    suffix = Path(filename).suffix.lstrip(".").lower()
    if suffix:
        return suffix

    subtype = media_type.split(";", 1)[0].partition("/")[2]
    return subtype or "wav"


def _prepare_message(
    message: ChatMessage,
) -> tuple[dict, list[DerivedObservation]]:
    content: list[dict] = []
    observations: list[DerivedObservation] = []

    if message.content.strip():
        content.append({"type": "text", "text": message.content})

    for image in message.images:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": _data_url(image, "image/png")},
            }
        )

    for source_part, part in enumerate(message.parts):
        if part.kind == "text":
            content.append({"type": "text", "text": part.text or ""})
            continue

        media_type = part.mediaType or "application/octet-stream"
        filename = part.filename or f"part-{source_part}"

        if part.kind == "image":
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": _data_url(part.data or "", media_type),
                    },
                }
            )
            observations.append(
                DerivedObservation(
                    kind="image",
                    sourcePart=source_part,
                    processor="gemma-4",
                )
            )
            continue

        data = decode_base64(part.data or "")

        if part.kind == "audio":
            content.append(
                {
                    "type": "input_audio",
                    "input_audio": {
                        "data": encode_base64(data),
                        "format": _audio_format(media_type, filename),
                    },
                }
            )
            observations.append(
                DerivedObservation(
                    kind="audio",
                    sourcePart=source_part,
                    processor="gemma-4",
                )
            )
            continue

        if part.kind == "video":
            processed = process_video(data, filename)

            for timestamp, frame in zip(
                processed.image_timestamps_ms,
                processed.images,
                strict=True,
            ):
                content.append(
                    {
                        "type": "text",
                        "text": f"Video frame at {timestamp} ms:",
                    }
                )
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": (
                                "data:image/jpeg;base64,"
                                f"{encode_base64(frame)}"
                            )
                        },
                    }
                )
                observations.append(
                    DerivedObservation(
                        kind="video_frame",
                        sourcePart=source_part,
                        processor="ffmpeg",
                        startMs=timestamp,
                        endMs=timestamp,
                    )
                )

            if processed.audio is not None:
                content.append(
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": encode_base64(processed.audio),
                            "format": "wav",
                        },
                    }
                )
                observations.append(
                    DerivedObservation(
                        kind="audio",
                        sourcePart=source_part,
                        processor="ffmpeg",
                    )
                )
            continue

        processed = process_document(data, media_type, filename)
        content.append(
            {
                "type": "text",
                "text": (
                    f"Document {filename}:\n"
                    f"{processed.text or '(no extractable text)'}"
                ),
            }
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
            content.append(
                {
                    "type": "text",
                    "text": f"Page {page} of {filename}:",
                }
            )
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": (
                            "data:image/jpeg;base64,"
                            f"{encode_base64(image)}"
                        )
                    },
                }
            )
            observations.append(
                DerivedObservation(
                    kind="image",
                    sourcePart=source_part,
                    processor="pdftoppm",
                )
            )

    if not content:
        raise HTTPException(status_code=422, detail="A message cannot be empty")

    prepared_content: str | list[dict]
    if len(content) == 1 and content[0]["type"] == "text":
        prepared_content = content[0]["text"]
    else:
        prepared_content = content

    return {"role": message.role, "content": prepared_content}, observations


def _client() -> httpx.AsyncClient:
    client = state["client"]
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Chat bots are still getting ready.",
        )
    return client


@app.get("/health")
async def health() -> JSONResponse:
    try:
        response = await _client().get("models", timeout=5)
    except HTTPException:
        raise
    except httpx.RequestError:
        response = None

    if response is None or response.status_code != 200:
        return JSONResponse(
            status_code=503,
            content={
                "status": "starting",
                "service": "ml",
                "execution": "cpu",
                "model": MODEL_ID,
                "message": "Chat bots are still getting ready.",
            },
        )

    return JSONResponse(
        content={
            "status": "ok",
            "service": "ml",
            "execution": "cpu",
            "model": MODEL_ID,
            "inputModalities": ["text", "image", "audio", "video", "file"],
        }
    )


@app.post("/v1/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    messages: list[dict] = []
    observations: list[DerivedObservation] = []

    if request.system.strip():
        messages.append({"role": "system", "content": request.system})

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
            detail="A media attachment could not be prepared.",
        ) from exception

    try:
        response = await _client().post(
            "chat/completions",
            json={
                "model": MODEL_ID,
                "messages": messages,
                "max_tokens": request.maxTokens,
                "temperature": request.temperature,
                "cache_prompt": True,
                "chat_template_kwargs": {"enable_thinking": False},
                "reasoning_format": "none",
                "stream": False,
            },
        )
    except HTTPException:
        raise
    except httpx.TimeoutException as exception:
        raise HTTPException(
            status_code=504,
            detail="The chat bot took too long to answer.",
        ) from exception
    except httpx.RequestError as exception:
        raise HTTPException(
            status_code=503,
            detail="Chat bots are still getting ready.",
        ) from exception

    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="Chat bots are busy.")

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Local inference returned HTTP {response.status_code}.",
        )

    try:
        payload = response.json()
        content = payload["choices"][0]["message"]["content"].strip()
    except (AttributeError, IndexError, KeyError, TypeError, ValueError) as exception:
        raise HTTPException(
            status_code=502,
            detail="Local inference returned an invalid response.",
        ) from exception

    if not content:
        raise HTTPException(
            status_code=502,
            detail="The chat bot returned an empty response.",
        )

    return ChatResponse(
        content=content,
        model=MODEL_ID,
        observations=observations,
    )

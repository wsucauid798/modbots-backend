import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

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

OPENAI_API_URL = "https://api.openai.com/v1"
MODEL_ID = os.environ.get("MODEL_ID", "").strip()
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()

_timeout = os.environ.get("INFERENCE_TIMEOUT_SECONDS", "").strip()
INFERENCE_TIMEOUT_SECONDS = float(_timeout) if _timeout else 0.0

state: dict[str, httpx.AsyncClient | None] = {"client": None}


def _validate_configuration() -> None:
    if not MODEL_ID:
        raise RuntimeError("MODEL_ID must be set.")

    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY must be set.")

    if INFERENCE_TIMEOUT_SECONDS <= 0:
        raise RuntimeError(
            "INFERENCE_TIMEOUT_SECONDS must be set to a positive number."
        )


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {OPENAI_API_KEY}"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    _validate_configuration()

    async with httpx.AsyncClient(
        base_url=f"{OPENAI_API_URL}/",
        timeout=INFERENCE_TIMEOUT_SECONDS,
        headers=_auth_headers(),
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


class ResearchRequest(BaseModel):
    system: str
    prompt: str
    maxTokens: int = Field(default=700, ge=100, le=4096)


class ResearchSource(BaseModel):
    title: str
    url: str


class ResearchResponse(BaseModel):
    content: str
    model: str
    sources: list[ResearchSource]


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


def _upstream_error(response: httpx.Response) -> str:
    """The backend's own explanation, so a refused request is diagnosable."""
    try:
        payload = response.json()
    except ValueError:
        return response.text.strip()[:300] or "no response body"

    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])[:300]

    if isinstance(error, str) and error:
        return error[:300]

    return str(payload)[:300]


def _upstream_error_code(response: httpx.Response) -> str:
    """Return the provider's machine-readable failure code when present."""
    try:
        payload = response.json()
    except ValueError:
        return ""

    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict) and isinstance(error.get("code"), str):
        return error["code"]

    return ""


def _duration_milliseconds(value: str) -> int:
    compact = re.sub(r"\s+", "", value)
    parts = re.findall(r"(\d+(?:\.\d+)?)(ms|s|m|h)", compact)

    parsed = "".join(f"{amount}{unit}" for amount, unit in parts)
    if not parts or parsed != compact:
        return 0

    multipliers = {"ms": 1, "s": 1_000, "m": 60_000, "h": 3_600_000}
    return round(
        sum(float(amount) * multipliers[unit] for amount, unit in parts)
    )


def _retry_after_milliseconds(response: httpx.Response) -> int:
    retry_after = response.headers.get("retry-after", "").strip()

    try:
        seconds = float(retry_after)
    except ValueError:
        seconds = 0

    if seconds > 0:
        return min(round(seconds * 1_000), 5 * 60_000)

    resets = (
        response.headers.get("x-ratelimit-reset-requests", ""),
        response.headers.get("x-ratelimit-reset-tokens", ""),
    )
    longest_reset = max(
        (_duration_milliseconds(value) for value in resets),
        default=0,
    )
    return min(longest_reset, 5 * 60_000)


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
                "execution": "hosted",
                "model": MODEL_ID,
                "message": "Chat bots are still getting ready.",
            },
        )

    try:
        models = response.json().get("data", [])
    except (AttributeError, ValueError):
        models = []

    if not any(
        isinstance(model, dict) and model.get("id") == MODEL_ID
        for model in models
    ):
        return JSONResponse(
            status_code=503,
            content={
                "status": "unavailable",
                "service": "ml",
                "execution": "hosted",
                "model": MODEL_ID,
                "message": "The configured chat model is unavailable.",
            },
        )

    return JSONResponse(
        content={
            "status": "ok",
            "service": "ml",
            "execution": "hosted",
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

    payload: dict = {
        "model": MODEL_ID,
        "messages": messages,
        "stream": False,
        "max_completion_tokens": request.maxTokens,
        "reasoning_effort": "none",
    }

    try:
        response = await _client().post("chat/completions", json=payload)
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
        code = _upstream_error_code(response)

        if code == "insufficient_quota":
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "insufficient_quota",
                    "message": (
                        "OpenAI rejected this project with insufficient_quota. "
                        "Verify the active organization, project, API key, and "
                        "billing status."
                    ),
                },
            )

        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": "Inference is rate limited. Try again later.",
                "retryAfterMs": _retry_after_milliseconds(response),
            },
        )

    if response.status_code in (401, 403):
        raise HTTPException(
            status_code=502,
            detail=(
                "OpenAI rejected the credentials "
                f"(HTTP {response.status_code}). Check OPENAI_API_KEY."
            ),
        )

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=(
                "OpenAI returned HTTP "
                f"{response.status_code}: {_upstream_error(response)}"
            ),
        )

    try:
        payload = response.json()
        content = payload["choices"][0]["message"]["content"].strip()
    except (AttributeError, IndexError, KeyError, TypeError, ValueError) as exception:
        raise HTTPException(
            status_code=502,
            detail="OpenAI returned an invalid response.",
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


def _response_text(payload: dict) -> str:
    direct = payload.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    parts: list[str] = []
    for item in payload.get("output", []):
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if not isinstance(content, dict):
                continue
            text = content.get("text")
            if content.get("type") == "output_text" and isinstance(text, str):
                parts.append(text.strip())
    return "\n".join(part for part in parts if part)


def _response_sources(payload: dict) -> list[ResearchSource]:
    found: dict[str, ResearchSource] = {}

    def remember(candidate: object) -> None:
        if not isinstance(candidate, dict):
            return
        url = candidate.get("url")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            return
        split = urlsplit(url)
        clean_query = urlencode(
            [
                (key, value)
                for key, value in parse_qsl(split.query, keep_blank_values=True)
                if not key.lower().startswith("utm_")
            ]
        )
        url = urlunsplit(
            (split.scheme, split.netloc, split.path, clean_query, split.fragment)
        )
        title = candidate.get("title")
        found[url] = ResearchSource(
            title=title.strip() if isinstance(title, str) and title.strip() else url,
            url=url,
        )

    for item in payload.get("output", []):
        if not isinstance(item, dict):
            continue
        for content in item.get("content", []):
            if not isinstance(content, dict):
                continue
            for annotation in content.get("annotations", []):
                if (
                    isinstance(annotation, dict)
                    and annotation.get("type") == "url_citation"
                ):
                    remember(annotation)

    for item in payload.get("output", []):
        if not isinstance(item, dict):
            continue
        action = item.get("action")
        if isinstance(action, dict):
            for source in action.get("sources", []):
                remember(source)

    return list(found.values())


@app.post("/v1/research", response_model=ResearchResponse)
async def research(request: ResearchRequest) -> ResearchResponse:
    payload = {
        "model": MODEL_ID,
        "instructions": request.system,
        "input": request.prompt,
        "tools": [
            {
                "type": "web_search",
                "search_context_size": "medium",
                "external_web_access": True,
            }
        ],
        "tool_choice": "required",
        "include": ["web_search_call.action.sources"],
        "max_output_tokens": request.maxTokens,
        "reasoning": {"effort": "low"},
    }

    try:
        response = await _client().post("responses", json=payload)
    except HTTPException:
        raise
    except httpx.TimeoutException as exception:
        raise HTTPException(
            status_code=504,
            detail="The chat bot took too long to research.",
        ) from exception
    except httpx.RequestError as exception:
        raise HTTPException(
            status_code=503,
            detail="Chat bots cannot reach the internet right now.",
        ) from exception

    if response.status_code == 429:
        code = _upstream_error_code(response)
        raise HTTPException(
            status_code=503 if code == "insufficient_quota" else 429,
            detail={
                "code": code or "rate_limited",
                "message": "Internet research is temporarily unavailable.",
                "retryAfterMs": _retry_after_milliseconds(response),
            },
        )

    if response.status_code in (401, 403):
        raise HTTPException(
            status_code=502,
            detail=(
                "OpenAI rejected the credentials "
                f"(HTTP {response.status_code}). Check OPENAI_API_KEY."
            ),
        )

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=(
                "OpenAI returned HTTP "
                f"{response.status_code}: {_upstream_error(response)}"
            ),
        )

    try:
        upstream = response.json()
        content = _response_text(upstream)
        sources = _response_sources(upstream)
    except (AttributeError, TypeError, ValueError) as exception:
        raise HTTPException(
            status_code=502,
            detail="OpenAI returned invalid research.",
        ) from exception

    if not content or not sources:
        raise HTTPException(
            status_code=502,
            detail="Internet research returned no sourced knowledge.",
        )

    return ResearchResponse(content=content, model=MODEL_ID, sources=sources)

import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

MANIFEST_VERSION = os.environ.get(
    "INFERENCE_MANIFEST_VERSION",
    "development-unpublished",
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield


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
    maxTokens: int = Field(default=80, ge=1, le=4096)
    temperature: float = Field(default=0.9, ge=0, le=2)


class PipelineSelection(BaseModel):
    manifestVersion: str
    pipelineId: str
    inputModalities: list[Literal["text", "image", "audio", "video", "file"]]
    requiredArtifactRoles: list[Literal["multimodal_reasoning"]]
    deterministicProcessors: list[Literal["document_text_extraction"]]


def select_pipeline(request: ChatRequest) -> PipelineSelection:
    modalities: list[Literal["text", "image", "audio", "video", "file"]] = []

    def include(modality):
        if modality not in modalities:
            modalities.append(modality)

    for message in request.messages:
        if message.content.strip():
            include("text")

        if message.images:
            include("image")

        for part in message.parts:
            include(part.kind)

    required_artifact_roles = ["multimodal_reasoning"]
    deterministic_processors = []

    if "file" in modalities:
        deterministic_processors.append("document_text_extraction")

    return PipelineSelection(
        manifestVersion=MANIFEST_VERSION,
        pipelineId="conversation.gemma-4.v1",
        inputModalities=modalities,
        requiredArtifactRoles=required_artifact_roles,
        deterministicProcessors=deterministic_processors,
    )


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "status": "waiting_for_client_inference",
            "service": "ml",
            "execution": "client",
            "manifestVersion": MANIFEST_VERSION,
            "message": "Chat bots are waiting for local inference to become ready.",
        },
    )


@app.post("/v1/pipelines/select", response_model=PipelineSelection)
def pipeline(request: ChatRequest) -> PipelineSelection:
    return select_pipeline(request)


@app.post("/v1/chat")
def chat(_: ChatRequest):
    raise HTTPException(
        status_code=503,
        detail="Chat bots are waiting for local inference to become ready.",
    )

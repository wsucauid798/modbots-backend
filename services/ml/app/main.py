import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from ollama import Client, RequestError, ResponseError
from pydantic import BaseModel, Field

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "https://ollama.com")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma4:31b-cloud")
OLLAMA_API_KEY = os.environ.get("OLLAMA_API_KEY", "")
OLLAMA_TIMEOUT_SECONDS = float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "120"))

state: dict[str, object | None] = {"client": None}


@asynccontextmanager
async def lifespan(_: FastAPI):
    if OLLAMA_HOST.rstrip("/") == "https://ollama.com" and not OLLAMA_API_KEY:
        raise RuntimeError("OLLAMA_API_KEY is required for Ollama Cloud")

    headers = (
        {"Authorization": f"Bearer {OLLAMA_API_KEY}"}
        if OLLAMA_API_KEY
        else None
    )
    state["client"] = Client(
        host=OLLAMA_HOST,
        headers=headers,
        timeout=OLLAMA_TIMEOUT_SECONDS,
    )
    yield
    state["client"] = None


app = FastAPI(lifespan=lifespan)


class ChatMessage(BaseModel):
    role: str
    content: str
    images: list[str] = Field(default_factory=list)


class ChatRequest(BaseModel):
    system: str
    messages: list[ChatMessage]
    maxTokens: int = 80
    temperature: float = 0.9


class ChatResponse(BaseModel):
    content: str


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "ml",
        "provider": "ollama-cloud",
        "model": OLLAMA_MODEL,
    }


@app.post("/v1/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    client = state["client"]
    if client is None:
        raise HTTPException(status_code=503, detail="ML client is not ready")

    messages = [{"role": "system", "content": request.system}]
    messages.extend(
        {
            "role": message.role,
            "content": message.content,
            **({"images": message.images} if message.images else {}),
        }
        for message in request.messages
    )

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

    return ChatResponse(content=content)

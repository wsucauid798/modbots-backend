# The ML service: model inference behind a small HTTP surface. Today it
# serves the chat bot minds; the same surface later serves mod bot scoring.
# The model is configurable and cached in HF_HOME, so first boot downloads
# and later boots are instant.
import os
import threading
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_ID = os.environ.get("ML_MODEL_ID", "Qwen/Qwen2.5-1.5B-Instruct")

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if device == "cuda" else torch.float32

state: dict = {"model": None, "tokenizer": None}
generate_lock = threading.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype=dtype)
    model.to(device)
    model.eval()
    state["tokenizer"] = tokenizer
    state["model"] = model
    yield


app = FastAPI(lifespan=lifespan)


class ChatMessage(BaseModel):
    role: str
    content: str


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
        "model": MODEL_ID,
        "device": device,
    }


@app.post("/v1/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    tokenizer = state["tokenizer"]
    model = state["model"]

    conversation = [{"role": "system", "content": request.system}] + [
        {"role": message.role, "content": message.content}
        for message in request.messages
    ]
    text = tokenizer.apply_chat_template(
        conversation, tokenize=False, add_generation_prompt=True
    )
    inputs = tokenizer(text, return_tensors="pt").to(device)

    with generate_lock, torch.no_grad():
        output = model.generate(
            **inputs,
            max_new_tokens=request.maxTokens,
            do_sample=True,
            temperature=request.temperature,
            top_p=0.95,
            repetition_penalty=1.1,
            pad_token_id=tokenizer.eos_token_id,
        )

    content = tokenizer.decode(
        output[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True
    ).strip()

    return ChatResponse(content=content)

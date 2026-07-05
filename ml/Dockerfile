FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime
WORKDIR /app

RUN pip install --no-cache-dir fastapi "uvicorn[standard]" transformers accelerate

COPY app ./app

ENV HF_HOME=/data/hf
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

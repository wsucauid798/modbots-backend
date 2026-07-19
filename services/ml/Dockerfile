FROM python:3.12-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg poppler-utils \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir fastapi "uvicorn[standard]"

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

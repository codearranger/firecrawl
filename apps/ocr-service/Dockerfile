FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py test_app.py ./

RUN useradd --system --uid 10001 ocr
USER ocr

ENV PORT=3010
EXPOSE 3010
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]

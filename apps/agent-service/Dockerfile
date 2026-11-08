FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py test_app.py ./

RUN useradd --system --uid 10001 agent
USER agent

ENV PORT=3020
EXPOSE 3020
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]

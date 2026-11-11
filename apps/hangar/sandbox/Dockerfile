# Per-session browser sandbox: Chromium + node/python Playwright + agent-browser.
FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates unzip curl libatomic1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/sandbox
COPY package.json ./
RUN npm install --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && pip3 install --no-cache-dir --break-system-packages playwright==1.65.0 \
 && rm -rf /root/.cache

# uBlock Origin Lite (MV3), loaded when a session asks for blockAds.
ARG UBOL_VERSION=2026.1026.1812
RUN curl -fsSL -o /tmp/ubol.zip \
      "https://github.com/uBlockOrigin/uBOL-home/releases/download/${UBOL_VERSION}/uBOLite_${UBOL_VERSION}.chromium.zip" \
 && mkdir -p /opt/ublock && unzip -q /tmp/ubol.zip -d /opt/ublock && rm /tmp/ubol.zip \
 && test -f /opt/ublock/manifest.json

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN npx tsc && chmod +x bin/*

# Non-root; the controller also runs the container with a read-only root
# filesystem, no capabilities and an internal-only network.
RUN useradd --uid 10001 --create-home --home-dir /tmp/home sandbox
USER 10001
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/agent.js"]

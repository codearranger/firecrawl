FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc && npm prune --omit=dev
# Same uid as the sandbox user, so both can read and write the shared data
# volume (profiles, recordings).
RUN useradd --uid 10001 --no-create-home hangar && mkdir -p /data && chown 10001:10001 /data
USER 10001
ENV API_PORT=3040 PUBLIC_PORT=3030 DATA_DIR=/data
EXPOSE 3040 3030
CMD ["node", "dist/server.js"]

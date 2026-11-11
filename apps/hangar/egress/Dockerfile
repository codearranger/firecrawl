FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc && npm prune --omit=dev
USER node
ENV PORT=3128
EXPOSE 3128
CMD ["node", "dist/egress.js"]

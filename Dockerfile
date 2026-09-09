FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev
COPY public ./public
COPY scripts ./scripts
COPY src ./src

ENV PORT=4310
ENV DATA_DIR=/data

EXPOSE 4310

CMD ["node", "src/server.js"]

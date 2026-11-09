# Optional. Prefer local Node on the Mac for development.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate \
  && pnpm install --frozen-lockfile=false --prod=false
COPY . .
RUN pnpm build && pnpm prune --prod
ENV HOST=127.0.0.1 PORT=8787 DATA_DIR=/data STICKERS_DIR=/data/stickers DB_PATH=/data/stickers.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]

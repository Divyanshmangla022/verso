# ---------------------------------------------------------------------------
# Verso — single-image production build.
# Stage 1 builds the static web app; stage 2 runs the API (Node 26 executes
# TypeScript natively, so the server needs no compile step) and serves web/dist.
# ---------------------------------------------------------------------------
FROM node:26-alpine AS webbuild
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY shared/ shared/
COPY web/ web/
RUN npm run build -w web

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# Server runtime deps only (workspace-aware); mongodb-memory-server et al. stay out.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY shared/ shared/
COPY server/ server/
COPY --from=webbuild /app/web/dist web/dist
EXPOSE 4000
USER node
CMD ["node", "server/src/index.ts"]

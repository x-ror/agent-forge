# ---- build stage -----------------------------------------------------------
FROM node:26-slim AS build
RUN npm install -g pnpm@10 && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter "@agentforge/server..."
COPY packages/core packages/core
COPY apps/server apps/server
RUN pnpm --filter @agentforge/core build && pnpm --filter @agentforge/server build \
  && pnpm --filter @agentforge/server deploy --prod --legacy /deploy

# ---- runtime stage ---------------------------------------------------------
# One image, two entrypoints (§11.1): api = default CMD, worker overrides it.
FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends git tini ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /deploy /app
ENV NODE_ENV=production
EXPOSE 3001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.api.js"]

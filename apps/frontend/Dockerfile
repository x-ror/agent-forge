# ---- build stage -----------------------------------------------------------
FROM node:26-slim AS build
RUN npm install -g pnpm@10
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile --filter "@agentforge/frontend..."
COPY packages/core packages/core
COPY apps/frontend apps/frontend
RUN pnpm --filter @agentforge/core build && pnpm --filter @agentforge/frontend build

# ---- runtime stage: nginx serving the SPA + /api/v1 proxy (§2.2) ----------
FROM nginx:alpine
COPY --from=build /repo/apps/frontend/dist /usr/share/nginx/html
COPY apps/frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
ENV API_ORIGIN=http://api:3001
EXPOSE 3000

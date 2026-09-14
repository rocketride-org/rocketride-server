# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter rocket-agent... \
	&& pnpm --filter rocket-agent build \
	&& pnpm --filter rocket-agent deploy --legacy --prod /out

FROM node:20-bookworm-slim
ARG OPENCODE_VERSION=1.18.16
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g opencode-ai@${OPENCODE_VERSION}
WORKDIR /app
COPY --from=build /out .
ENV RR_AGENT_DATA_DIR=/var/lib/rocket-agent
USER node
EXPOSE 8790
CMD ["node", "dist/index.js"]

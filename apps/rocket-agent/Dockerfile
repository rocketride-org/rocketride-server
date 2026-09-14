# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
RUN corepack enable
# The root workspace's "prepare" script (lefthook install --force) installs git
# hooks, which are meaningless inside an image build (no .git dir is present —
# .dockerignore excludes it — and no git binary is installed in this stage
# either). Skip lifecycle install scripts for this build entirely: the only
# dependency in rocket-agent's + client-typescript's resolved closure that pnpm's
# onlyBuiltDependencies allowlist (pnpm-workspace.yaml) would otherwise build is
# unrs-resolver, a transitive of jest-resolve used only by `pnpm test`, which
# never runs in this image.
ENV npm_config_ignore_scripts=true
WORKDIR /repo
COPY . .
# `rocketride` (packages/client-typescript) is a workspace dep whose package.json
# has NO scripts and whose dist/ is gitignored — the monorepo builds it through
# scripts/build.js, not pnpm. Without this line the image ships a dependency with
# no dist and `node dist/index.js` dies at require time. See cloud-bringup-design D-7.
RUN pnpm install --frozen-lockfile --filter rocket-agent... \
	&& node scripts/build.js client-typescript:build \
	&& pnpm --filter rocket-agent build \
	&& pnpm --filter rocket-agent deploy --legacy --prod /out

FROM node:20-bookworm-slim
ARG OPENCODE_VERSION=1.18.16
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g opencode-ai@${OPENCODE_VERSION}
WORKDIR /app
COPY --from=build /out .
# Without HOME set explicitly, the kubelet supplies HOME=/root regardless of
# the container's USER — uid 1000 (node) can't write there, so `opencode`
# child processes writing to ~/.config / XDG paths fail in-cluster (this
# works locally because `docker run` inherits the shell's own HOME).
# node:20-bookworm-slim already provides /home/node owned by uid 1000.
ENV RR_AGENT_DATA_DIR=/var/lib/rocket-agent
ENV HOME=/home/node
USER node
EXPOSE 8790
CMD ["node", "dist/src/index.js"]

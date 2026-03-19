FROM node:lts-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build && pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
WORKDIR /app
COPY --chown=node:node --from=build /app /app
ARG CLAUDE_CODE_VERSION=2.1.78
ARG GEMINI_CLI_VERSION=0.34.0
ARG CODEX_VERSION=0.115.0
ARG OPENCODE_VERSION=1.2.27
ARG COMMIT_SHA=unknown
LABEL org.opencontainers.image.revision=$COMMIT_SHA
RUN apt-get update \
  && apt-get install -y --no-install-recommends gh openssh-client ripgrep fd-find procps tree patch \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && mkdir -p /usr/local/lib/paperclip \
  && mv /usr/bin/gh /usr/local/lib/paperclip/gh-real \
  && ln -sf /app/scripts/gh.sh /usr/bin/gh \
  && rm -rf /var/lib/apt/lists/*
# Playwright system dependencies (required for browser-based agent tasks)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
    libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libgtk-3-0t64 libgtk-4-1 \
    libsoup-3.0-0 gstreamer1.0-libav gstreamer1.0-plugins-bad gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good xvfb fonts-noto-color-emoji fonts-unifont fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/paperclip-opencode /paperclip \
  && npm install --global --omit=dev \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
  && npm install --prefix /opt/paperclip-opencode --omit=dev "opencode-ai@${OPENCODE_VERSION}" \
  && chmod +x /app/scripts/docker-entrypoint.sh /app/scripts/gh.sh \
  && chown -R node:node /paperclip /opt/paperclip-opencode

ENV NODE_ENV=production \
  HOME=/paperclip \
  XDG_CONFIG_HOME=/paperclip/.config \
  XDG_DATA_HOME=/paperclip/.local/share \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PATH=/paperclip/bin:${PATH} \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_OPENCODE_COMMAND=/paperclip/bin/opencode \
  PAPERCLIP_OPENCODE_INSTALL_DIR=/opt/paperclip-opencode \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private

VOLUME ["/paperclip"]
EXPOSE 3100

USER node
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]

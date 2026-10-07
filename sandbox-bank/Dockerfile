# Live sandbox bank (mock FIP + AA). Build context: the repo root, so the
# image can carry the enclave's pinned public keys (the bank refuses to start
# if its keys differ from them):
#   docker build -f sandbox-bank/Dockerfile -t tio-sandbox-bank:dev .
# The context is narrowed by sandbox-bank/Dockerfile.dockerignore.
# Secrets (SANDBOX_AA_PRIVATE_JWK, SANDBOX_FIP_PRIVATE_JWK) come from the
# environment at run time, never from the image.

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sandbox-bank/package.json sandbox-bank/
RUN pnpm install --frozen-lockfile --prod --filter @tio/sandbox-bank

COPY sandbox-bank/src/ sandbox-bank/src/
COPY enclave/pinned/ pinned/

ENV NODE_ENV=production \
    PINNED_DIR=/app/pinned \
    PORT=8081
USER node
EXPOSE 8081
CMD ["node", "sandbox-bank/src/service/main.ts"]

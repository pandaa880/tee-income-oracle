# Gateway (orchestrator + relayer). Build context: the repo root, so the image
# can carry deployments/, the default policy and the two program clients
# (@tio/oracle-client: the Codama-generated code + the hand-written attest helpers;
# @tio/demo-pool-client: the generated demo-pool client the loan relay checks against):
#   docker build -f gateway/Dockerfile -t tio-gateway:dev .
# The context is narrowed by gateway/Dockerfile.dockerignore.
# Secrets (RELAYER_KEYPAIR) and config come from the environment at run time,
# never from the image.

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY gateway/package.json gateway/
COPY clients/ts/oracle/package.json clients/ts/oracle/
COPY clients/ts/demo-pool/package.json clients/ts/demo-pool/
COPY sandbox-bank/package.json sandbox-bank/
COPY packages/encoding/package.json packages/encoding/
RUN pnpm install --frozen-lockfile --prod --filter "@tio/gateway..."

# The generated clients use `enum` and extensionless imports: run under tsx.
COPY clients/ts/oracle/src/ clients/ts/oracle/src/
COPY clients/ts/demo-pool/src/ clients/ts/demo-pool/src/
COPY sandbox-bank/src/crypto/jcs.ts sandbox-bank/src/crypto/
COPY packages/encoding/src/encoding.ts packages/encoding/src/
COPY deployments/ deployments/
COPY test-vectors/policy/default.json test-vectors/policy/
COPY gateway/src/ gateway/src/

ENV NODE_ENV=production \
    PORT=8082
USER node
EXPOSE 8082
WORKDIR /app/gateway
CMD ["node", "--import", "tsx", "src/main.ts"]

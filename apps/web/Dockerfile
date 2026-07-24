# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS dependencies

ENV COREPACK_HOME=/corepack
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.15.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json tsconfig.json ./
COPY packages/adapters/package.json packages/adapters/tsconfig.build.json packages/adapters/tsconfig.json ./packages/adapters/
COPY packages/application/package.json packages/application/tsconfig.build.json packages/application/tsconfig.json ./packages/application/
COPY packages/contracts/package.json packages/contracts/tsconfig.build.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/db/package.json packages/db/tsconfig.build.json packages/db/tsconfig.json ./packages/db/
COPY packages/domain/package.json packages/domain/tsconfig.build.json packages/domain/tsconfig.json ./packages/domain/
COPY apps/api/package.json apps/api/tsconfig.build.json apps/api/tsconfig.json ./apps/api/
COPY apps/web/package.json apps/web/next-env.d.ts apps/web/next.config.ts apps/web/tsconfig.json ./apps/web/
COPY apps/worker/package.json apps/worker/tsconfig.build.json apps/worker/tsconfig.json ./apps/worker/

RUN --mount=type=cache,id=aeostudio-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS build

COPY packages/domain/src ./packages/domain/src
COPY packages/application/src ./packages/application/src
COPY packages/adapters/src ./packages/adapters/src
COPY packages/contracts/src ./packages/contracts/src
COPY apps/web/src ./apps/web/src

RUN pnpm --filter @aeostudio/web... build

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime

# The final service executes compiled JavaScript only; package managers remain in the build stage.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3100
WORKDIR /workspace
COPY --chown=node:node --from=build /workspace/apps/web/.next/standalone /workspace
COPY --chown=node:node --from=build /workspace/apps/web/.next/static /workspace/apps/web/.next/static
# Image optimization is disabled; do not redistribute its optional libvips runtime.
RUN rm -rf /workspace/node_modules/.pnpm/sharp@* \
      /workspace/node_modules/.pnpm/@img+* \
      /workspace/node_modules/.pnpm/node_modules/@img \
      /workspace/node_modules/sharp
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "-e", "delete process.env.NEXT_MANUAL_SIG_HANDLE; require('./apps/web/server.js')"]

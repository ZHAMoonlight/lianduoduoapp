ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY app ./app
COPY frontend ./frontend
COPY lib ./lib
COPY public ./public
COPY scripts/compile-local.mjs ./scripts/compile-local.mjs
COPY index.html vite.local.config.ts tsconfig.json ./
# local/build.mjs also writes the native mini-program config. Server builds do not.
RUN node scripts/compile-local.mjs \
    && node node_modules/vite/bin/vite.js build --config vite.local.config.ts

FROM ${NODE_IMAGE} AS runtime-dependencies
WORKDIR /runtime
COPY deploy/runtime/package.json deploy/runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 API_PORT=3001
WORKDIR /app
COPY --chown=node:node deploy/runtime/package.json ./package.json
COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.local-runtime ./.local-runtime
COPY --from=build --chown=node:node /app/dist-local/client ./dist-local/client
COPY --chown=node:node server ./server
COPY --chown=node:node local/env.mjs local/init-mysql.mjs ./local/
COPY --chown=node:node deploy/start.mjs ./deploy/start.mjs
USER node
EXPOSE 3001
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
    CMD node --input-type=module -e "try { const r=await fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/api/setup',{signal:AbortSignal.timeout(4000)}); process.exit(r.ok?0:1); } catch { process.exit(1); }"
CMD ["node", "deploy/start.mjs"]

# syntax=docker/dockerfile:1.7
#
# The server runs with its working directory at /app/server because it resolves the built web
# app relative to the process CWD (server/src/index.ts). Keep that layout if you change this.

FROM node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS build-server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS build-web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
# The web app imports the server's shared contracts through the @shared and @routes aliases
# (web/tsconfig.json paths, web/vite.config.ts resolve.alias), so the server sources have to be
# present at the same relative position they occupy in the repository or type-checking fails.
COPY server/src /app/server/src
COPY web/ ./
RUN npm run build

# Production dependencies are installed on the same base as the runtime so that
# better-sqlite3's native binding is built against the same glibc it will run on.
FROM node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS prod-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime

ARG APP_VERSION=0.1.0
ARG VCS_REF=v0.1.0
LABEL org.opencontainers.image.title="Control AI Chat" \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install --no-install-recommends -y \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server

COPY --from=prod-deps    /app/server/node_modules ./node_modules
COPY --from=build-server /app/server/dist         ./dist
COPY                     server/package.json      ./package.json
COPY --from=build-web    /app/web/dist            /app/web/dist

# The data directory is the only writable path. It holds the SQLite database, its WAL sidecars,
# and uploaded files. Mount a volume here; a container-local copy is lost on every upgrade.
RUN mkdir -p /data/uploads && chown -R node:node /data
VOLUME ["/data"]

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3010 \
    DB_PATH=/data/app.db \
    UPLOAD_DIR=/data/uploads

USER node

EXPOSE 3010

# Fails the container when migrations could not run or the database is unreadable, because the
# health route reports the database state rather than merely that the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/api/health').then(r=>r.json()).then(b=>process.exit(b.db==='ok'?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

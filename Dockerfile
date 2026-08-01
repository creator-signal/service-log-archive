# syntax=docker/dockerfile:1.18@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf
FROM node:24.15.0-alpine3.23@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS verified-source
WORKDIR /opt/log-archive
COPY package.json ./
COPY src ./src
COPY public ./public
RUN node --check src/index.mjs && node --check src/server.mjs && node --check public/app.js

FROM node:24.15.0-alpine3.23@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="service-log-archive" \
      org.opencontainers.image.description="Standalone log rotation, archival, API, and operator UI service" \
      org.opencontainers.image.source="https://github.com/creator-signal/service-log-archive" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"
RUN addgroup -S -g 10001 logarchive \
    && adduser -S -D -H -u 10001 -G logarchive logarchive \
    && apk add --no-cache openssl=3.5.7-r0 libssl3=3.5.7-r0 libcrypto3=3.5.7-r0 \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && mkdir -p /var/lib/log-archive/state /var/lib/log-archive/spool /var/lib/log-archive/archive /logs \
    && chown -R 10001:10001 /var/lib/log-archive /logs
WORKDIR /opt/log-archive
COPY --from=verified-source --chown=10001:10001 /opt/log-archive ./
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/readyz || exit 1
CMD ["node", "src/index.mjs"]

FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS node-runtime
FROM postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 AS base
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
# zlib and nghttp2 at least at Alpine's fixes for CVE-2026-85091 and
# CVE-2026-58055 (#167); a floor, so a later Alpine revision still builds.
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && apk add --no-cache age ca-certificates 'zlib>=1.3.2-r1' 'nghttp2-libs>=1.70.0-r0' \
    && npm install --global pnpm@11.19.0
WORKDIR /app
ENTRYPOINT []
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

FROM dependencies AS development
COPY . .
EXPOSE 3000
CMD ["pnpm", "dev", "--hostname", "0.0.0.0"]

FROM development AS tooling
RUN apk add --no-cache git util-linux

FROM development AS builder
RUN pnpm build && node scripts/build-runtime.mjs

FROM builder AS production
ENV NODE_ENV=production
# COPY preserves host modes, including source extracted under umask 077.
# Image contents contain code only; secrets are supplied outside the image.
# Give the runtime read/traverse access without granting write access to source.
RUN chmod -R a+rX /app \
    && grep -q '^ping:x:999:' /etc/group && delgroup ping \
    && addgroup -g 999 fair-shifts && adduser -D -u 999 -G fair-shifts fair-shifts \
    && chown -R fair-shifts:fair-shifts /app/.next \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/pnpm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/gosu \
    && find node_modules -type f \
       \( -path '*/@esbuild/*/bin/esbuild' -o -path '*/esbuild/bin/esbuild' \) -delete
# The deletion log (decision 196) lives on its own volume, written by the worker as this user.
RUN mkdir -p /var/lib/fair-shifts-deletion-log \
    /var/lib/fair-shifts-backups \
    && chown fair-shifts:fair-shifts /var/lib/fair-shifts-deletion-log /var/lib/fair-shifts-backups
# Site and worker share one image; the health check compares their versions.
ARG APP_VERSION=development
ENV APP_VERSION=$APP_VERSION
USER fair-shifts
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]

FROM node:24.19.0-bookworm-slim AS node-runtime
FROM postgres:18.6-bookworm AS base
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && apt-get update && apt-get install -y --no-install-recommends age ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.19.0
WORKDIR /app
ENTRYPOINT []
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS development
COPY . .
EXPOSE 3000
CMD ["pnpm", "dev", "--hostname", "0.0.0.0"]

FROM development AS tooling
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

FROM development AS builder
RUN pnpm build

FROM builder AS production
ENV NODE_ENV=production
RUN chown -R postgres:postgres /app/.next
# Site and worker share one image; the health check compares their versions.
ARG APP_VERSION=development
ENV APP_VERSION=$APP_VERSION
USER postgres
CMD ["pnpm", "start", "--hostname", "0.0.0.0"]

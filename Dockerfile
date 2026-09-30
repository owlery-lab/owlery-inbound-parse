FROM oven/bun:1.3-alpine AS base

# NODE_ENV stays at development for the install step so devDependencies
# (typescript, @types/bun) are available for the build-time typecheck.
# Overridden to production at the end for runtime.
ENV PORT=3000
ENV DB_PATH=/data/owlery-inbound.db
ENV INBOUND_ATTACHMENTS_DIR=/data/inbound-parse

# su-exec lets the entrypoint chown /data as root and then drop privileges to
# `bun` for the actual server process. wget is used by the container HEALTHCHECK.
RUN apk add --no-cache su-exec wget

WORKDIR /app

# Install dependencies first for better layer caching. Bun installs
# devDependencies by default; NODE_ENV=production would skip them and break
# the typecheck below.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source. .dockerignore keeps data/, node_modules/, .env, tests, and docs
# out of the image. Bun runs the TypeScript directly, so nothing is compiled.
COPY . .

# Run a typecheck at build time so a broken image is caught early.
RUN bun run typecheck

# Create the data directory owned by the bun user (uid 1000 in the oven/bun
# image). Docker copies this ownership into a new named volume the first time
# it's mounted at /data.
RUN mkdir -p /data && chown -R bun:bun /data && chmod 700 /data

# Runtime: drop into production so Node ecosystem libs pick the prod path.
ENV NODE_ENV=production

# The server starts as root only so the entrypoint can fix /data ownership.
# It then switches to `bun`. `docker compose exec` also defaults to root, so
# run CLI commands with `-u bun` (as the docs show) to keep every database file
# owned by bun.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --spider --quiet http://localhost:3000/health || exit 1

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["bun", "src/api/server.ts"]

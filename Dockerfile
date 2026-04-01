# ── Build stage ───────────────────────────────────────
FROM node:24-alpine AS builder

ARG APP_NAME
RUN test -n "$APP_NAME" || (echo "APP_NAME build arg is required" && exit 1)

WORKDIR /app

# Root manifests — changes bust the install cache
COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn/releases/ .yarn/releases/

# Each workspace member must have its package.json on disk before `yarn install`:
# Yarn validates all workspace entries in yarn.lock are resolvable, and --immutable
# forbids updating the lockfile when workspace directories are missing.
COPY apps/api-gateway/package.json            apps/api-gateway/package.json
COPY apps/inventory-microservice/package.json apps/inventory-microservice/package.json
COPY apps/retail-microservice/package.json    apps/retail-microservice/package.json
COPY apps/notification-microservice/package.json apps/notification-microservice/package.json
# Invoke the bundled Yarn 4 binary directly — avoids corepack downloading from registry
RUN node .yarn/releases/yarn-4.12.0.cjs install --immutable

# Source copied after install so the install layer is cached across source-only changes
COPY tsconfig.json nest-cli.json webpack.config.js ./
COPY libs/ libs/
COPY apps/ apps/

RUN node .yarn/releases/yarn-4.12.0.cjs build:${APP_NAME}

# ── Runtime stage ─────────────────────────────────────
FROM node:24-alpine

ARG APP_NAME

ENV NODE_ENV=production
WORKDIR /app

# Copy pre-installed node_modules from builder — no yarn install needed in runtime,
# which also avoids the same workspace resolution issue.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/${APP_NAME}/ ./dist/

CMD ["node", "dist/main.js"]

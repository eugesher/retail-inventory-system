# ── Build stage ───────────────────────────────────────
FROM node:24-alpine AS builder

ARG APP_NAME
RUN test -n "$APP_NAME" || (echo "APP_NAME build arg is required" && exit 1)

WORKDIR /app

RUN corepack enable

COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn/releases/ .yarn/releases/
RUN yarn install --immutable

COPY tsconfig.json nest-cli.json webpack.config.js ./
COPY libs/ libs/
COPY apps/${APP_NAME}/ apps/${APP_NAME}/

RUN yarn build:${APP_NAME}

# ── Runtime stage ─────────────────────────────────────
FROM node:24-alpine

ARG APP_NAME

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn/releases/ .yarn/releases/
RUN yarn install --immutable

COPY --from=builder /app/dist/apps/${APP_NAME}/ ./dist/

CMD ["node", "dist/main.js"]

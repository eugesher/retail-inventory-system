FROM node:24-alpine AS base

WORKDIR /app

COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn/releases/ .yarn/releases/

COPY apps/ apps/

RUN YARN_BIN="$(sed -n 's/^yarnPath: *//p' .yarnrc.yml)" \
 && test -n "$YARN_BIN" \
 && node "$YARN_BIN" install --immutable

FROM base AS builder

ARG APP_NAME
RUN test -n "$APP_NAME" || (echo "APP_NAME build arg is required" && exit 1)

COPY tsconfig.json nest-cli.json webpack.config.js ./
COPY libs/ libs/

RUN YARN_BIN="$(sed -n 's/^yarnPath: *//p' .yarnrc.yml)" \
 && test -n "$YARN_BIN" \
 && node "$YARN_BIN" build:${APP_NAME}

FROM base AS prod-deps

RUN YARN_BIN="$(sed -n 's/^yarnPath: *//p' .yarnrc.yml)" \
 && test -n "$YARN_BIN" \
 && node "$YARN_BIN" workspaces focus --all --production

FROM node:24-alpine

ARG APP_NAME

ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/${APP_NAME}/ ./dist/

CMD ["node", "dist/main.js"]

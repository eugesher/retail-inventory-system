# ── Build stage ───────────────────────────────────────
FROM node:24-alpine AS builder

ARG APP_NAME
RUN test -n "$APP_NAME" || (echo "APP_NAME build arg is required" && exit 1)

WORKDIR /app

# Root manifests — changes bust the install cache
COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn/releases/ .yarn/releases/

# Every workspace member's package.json must be on disk before `yarn install`:
# Yarn validates that all workspace entries in yarn.lock are resolvable, and
# --immutable forbids updating the lockfile when a workspace directory is missing.
#
# The whole tree is copied rather than the manifests one by one, ON PURPOSE. The
# hand-written list this replaces had drifted to four of six apps and could not
# say so: a new app builds fine (`nest build` reads nest-cli.json, not the
# workspace graph) right up until it becomes a workspace member, at which point
# the omission surfaces as an unresolvable workspace during install. A list that
# fails only in that one combination is a list nobody maintains.
#
# The cost is cache granularity: any source change under apps/ now invalidates
# the install layer. That is acceptable here — Docker builds run from
# docker-compose and are not in the dev loop (`yarn start:dev`) or in CI, which
# builds on the host. `.dockerignore` keeps node_modules/dist/.git out, so the
# copy itself is cheap.
#
# To restore per-manifest cache granularity without a hand-written list, add
# `# syntax=docker/dockerfile:1.7-labs` at the top of this file and use
# `COPY --parents apps/*/package.json ./` here instead. That trades a labs
# Dockerfile frontend (pulled over the network at build time) for the finer cache.
COPY apps/ apps/

# Invoke the bundled Yarn 4 binary directly — avoids corepack downloading from registry
RUN node .yarn/releases/yarn-4.12.0.cjs install --immutable

# Remaining sources. `apps/` is already present from the install layer above.
COPY tsconfig.json nest-cli.json webpack.config.js ./
COPY libs/ libs/

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

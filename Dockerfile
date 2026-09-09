# ── Build stage ───────────────────────────────────────
# The base image floats on the major, and that is a gap worth stating rather than hiding.
# `.nvmrc` holds the one declaration of the Node version — CI reads it through
# `node-version-file`, a developer reads it through `nvm use`. This file cannot: a `FROM` line
# cannot read a file, and passing the version as a build arg would put a fourth copy into
# `docker-compose.yml`. So the Node in these images is "latest 24.x at build time" and is not
# guaranteed to equal the version CI tested on.
#
# Do not "fix" this by hard-coding that version here without also deciding who keeps the two in
# step: an unreconciled copy is worse than a stated gap. (The version is deliberately not repeated
# in this comment either.)
FROM node:24-alpine AS base

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

# Invoke the bundled Yarn binary directly rather than through corepack, which would reach the
# registry mid-build.
#
# The path is READ from `.yarnrc.yml`, not repeated here. `yarn set version` rewrites `yarnPath`,
# `packageManager` and the file under `.yarn/releases/` in one command and knows nothing about this
# Dockerfile — a literal copied into it survives that bump and then points at a binary that no
# longer exists. The failure would land on whoever next builds an image, not on whoever upgraded
# Yarn (their host build, lint and tests all stay green), and Docker builds are in neither the dev
# loop nor CI, so the two can be far apart.
#
# The expression appears twice because a shell variable does not outlive a RUN. Two copies of a
# derivation are not two copies of a fact: both always yield whatever the single source says.
# `test -n` turns a missing or renamed key into a build failure that names itself, rather than
# `node` being handed an empty path.
RUN YARN_BIN="$(sed -n 's/^yarnPath: *//p' .yarnrc.yml)" \
 && test -n "$YARN_BIN" \
 && node "$YARN_BIN" install --immutable

# ── Build stage ───────────────────────────────────────
FROM base AS builder

ARG APP_NAME
RUN test -n "$APP_NAME" || (echo "APP_NAME build arg is required" && exit 1)

# Remaining sources. `apps/` is already present from the install layer above.
COPY tsconfig.json nest-cli.json webpack.config.js ./
COPY libs/ libs/

RUN YARN_BIN="$(sed -n 's/^yarnPath: *//p' .yarnrc.yml)" \
 && test -n "$YARN_BIN" \
 && node "$YARN_BIN" build:${APP_NAME}

# ── Production dependencies ───────────────────────────
# The bundle does NOT inline npm packages — `webpack.config.js` uses `webpack-node-externals`
# with only `@retail-inventory-system/*` allowlisted — so `node_modules` genuinely has to ship.
# The DEV half of it does not, and it dominates: before this stage the runtime image was 882 MB,
# of which 541.7 MB was `node_modules` against 1.0 MB of `dist`.
#
# `yarn workspaces focus --production` re-installs the tree with `devDependencies` excluded.
# It is a built-in of Yarn 4 (`workspace-tools`), so nothing has to be added to `.yarnrc.yml`.
#
# This stage derives from `base`, NOT from `builder`, on purpose: it does not depend on
# `APP_NAME`, so all six images share one pruned tree and one layer. Deriving it from `builder`
# would prune six times and cache none of it.
FROM base AS prod-deps

RUN YARN_BIN="$(sed -n 's/^yarnPath: *//p' .yarnrc.yml)" \
 && test -n "$YARN_BIN" \
 && node "$YARN_BIN" workspaces focus --all --production

# ── Runtime stage ─────────────────────────────────────
FROM node:24-alpine

ARG APP_NAME

ENV NODE_ENV=production
WORKDIR /app

# Production-only `node_modules` from the pruned stage, and just this app's bundle from the
# builder. No install runs here, which also avoids the workspace-resolution problem entirely.
#
# `NODE_ENV=production` above is load-bearing now, not decorative: `LoggerModuleConfig` reaches
# for the `pino-pretty` transport on every non-production boot, and `pino-pretty` is a
# devDependency that this image no longer carries. Running this image without that variable
# would fail at logger construction.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/${APP_NAME}/ ./dist/

CMD ["node", "dist/main.js"]

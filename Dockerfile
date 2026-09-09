# ── Build stage ───────────────────────────────────────
# The base image floats on the major, and that is a gap worth stating rather than hiding.
# `.nvmrc` holds the one declaration of the Node version (24.13.1) — CI reads it through
# `node-version-file`, a developer reads it through `nvm use`. This file cannot: a `FROM` line
# cannot read a file, and passing the version as a build arg would put a fourth copy into
# `docker-compose.yml`. So the Node in these images is "latest 24.x at build time" and is not
# guaranteed to equal the version CI tested on.
#
# Do not "fix" this by hard-coding 24.13.1 here without also deciding who keeps the two in step:
# an unreconciled copy is worse than a stated gap.
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

# Remaining sources. `apps/` is already present from the install layer above.
COPY tsconfig.json nest-cli.json webpack.config.js ./
COPY libs/ libs/

RUN YARN_BIN="$(sed -n 's/^yarnPath: *//p' .yarnrc.yml)" \
 && test -n "$YARN_BIN" \
 && node "$YARN_BIN" build:${APP_NAME}

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

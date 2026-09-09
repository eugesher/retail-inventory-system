# ADR-062: Pruning dev dependencies out of the runtime image, and the `NODE_ENV` it now requires

- **Date**: 2026-09-10
- **Status**: Accepted

---

## Context

[ADR-061](061-one-parameterized-dockerfile.md) measured what the runtime image costs and left it
open:

| | before |
| --- | --- |
| image | 882 MB |
| `/app/node_modules` | 541.7 MB |
| `/app/dist` | 1.0 MB |

The runtime stage copied `node_modules` straight out of the builder, which had run a full
`yarn install --immutable`. So every image shipped the **dev** tree: `@types` 70 MB,
`@angular-devkit` 25 MB, `typescript` 23 MB, `@jest` 16 MB — roughly 135 MB of tooling that cannot
be reached at runtime, six times over.

`node_modules` itself has to ship: `webpack.config.js` uses `webpack-node-externals` with only
`@retail-inventory-system/*` allowlisted, so npm packages are `require`d at run time rather than
inlined into the 1 MB bundle. Only the dev half is dead weight.

### The blocker named in ADR-061's `Open` did not exist

That item said the mechanism *"needs the `workspace-tools` plugin, and `.yarn/plugins/` is
currently empty"*. Wrong, and one command says so:

```
$ yarn plugin import workspace-tools
YN0051: Couldn't find a plugin named @yarnpkg/plugin-workspace-tools on the remote registry.
A plugin named @yarnpkg/plugin-workspace-tools is already installed;
possibly attempting to import a built-in plugin.
```

`workspace-tools` is **built into Yarn 4**. `yarn workspaces focus --production` was available the
whole time. The Open item had recorded a cost that was not real, and a recorded cost is exactly the
kind of thing nobody re-checks — it reads as due diligence.

### The split was already right, and that could not be established by reading

`dependencies` (44) holds every runtime package; `devDependencies` (39) holds only tooling.
`source-map-support` — which the webpack `BannerPlugin` injects as
`require("source-map-support").install()` into every bundle — is correctly a **dependency**, so the
one obvious trap was already avoided.

But "reading the manifest" is not evidence here. `@opentelemetry/auto-instrumentations-node`
resolves instrumentation packages **dynamically at boot**, so the static graph does not describe
what the process will actually require. The only way to know is to run every image.

## Decision

### 1. Three stages: `base` → {`builder`, `prod-deps`} → runtime

`base` does the manifests and the full install. `builder` adds the sources and runs
`build:${APP_NAME}`. `prod-deps` re-installs without dev dependencies. The runtime stage takes
`node_modules` from `prod-deps` and only its own bundle from `builder`.

**`prod-deps` derives from `base`, not from `builder`, and that is the load-bearing part.** It
therefore does not depend on `APP_NAME`, so the pruned tree is built **once** and shared as one
layer by all six images. Deriving it from `builder` would produce the same bytes six times and
cache none of them.

### 2. `yarn workspaces focus --all --production`

A built-in, so `.yarnrc.yml` gains nothing and no plugin has to be vendored.

### 3. The image now REQUIRES `NODE_ENV=production`

This is a new constraint on how the artifact is run, and it is the reason this is an ADR rather
than a build tweak.

`LoggerModuleConfig` reaches for the `pino-pretty` transport on every non-production boot, and
`pino-pretty` is a `devDependency` the image no longer carries. Before this change the image
tolerated a wrong `NODE_ENV`; now it does not. Verified rather than reasoned:

```
$ docker run --network host --env-file … -e NODE_ENV=development <image>
Error: unable to determine transport target for "pino-pretty"
exit=1
```

The `Dockerfile` already sets it, so the default path is safe; what changed is that overriding it
is now fatal. The failure is immediate and names the missing target, which is the acceptable shape
for a constraint of this kind.

## Alternatives Considered

**Leave it** — ADR-061's state. Rejected once the cost was measured and the blocker turned out not
to exist: 353 MB per image, six images, for tooling that cannot execute.

**Bundle npm packages into the webpack output** (drop `webpack-node-externals`) so `node_modules`
need not ship at all. Rejected: `argon2` is a native module and cannot be bundled, and
`@opentelemetry/auto-instrumentations-node` resolves its targets dynamically — bundling would break
both, and the failure mode of the second is silent (instrumentation quietly finds nothing).

**Delete dev-dependency directories by name after the install.** Rejected: transitive dependencies
are shared between the two sets, so a name-based sweep either leaves most of the weight or removes
something a runtime package needs. `focus --production` re-resolves, which is the only correct
version of this.

**A slimmer base image (distroless, `-slim`).** Orthogonal and compounding — worth doing later, and
it does not address the 542 MB that dominated.

## Consequences

### Positive

| | before | after |
| --- | --- | --- |
| image | 882 MB | **529 MB** (−40%) |
| `/app/node_modules` | 541.7 MB | **247.1 MB** (−54%) |

All six images verified, not just the one that was measured: each was built, started against live
MySQL / Redis / RabbitMQ, and the gateway's health fan-out (ADR-044) answered `ok` for all five
microservices — which is a single call that proves every image booted **and** is serving RPC. A
staff login through the pruned gateway additionally exercised `argon2` (native), MySQL and JWT.

### Negative / Trade-offs

- **`NODE_ENV=production` is now mandatory**, per §3.
- The `prod-deps` stage is a second install. It runs once per build of the whole set rather than
  once per image, and Docker builds are in neither the dev loop nor CI (ADR-061), so the cost lands
  where it is cheapest.
- **One pruned tree for six images means each image carries every app's runtime dependencies.**
  `handlebars` is only ever loaded by the notification service; `swagger-ui-dist` (11.2 MB) only by
  the gateway. Per-app precision would need per-app `dependencies` in the workspace manifests —
  which [ADR-058](058-workspace-membership-and-the-list-that-could-not-fail.md) §1 deliberately
  emptied, on the grounds that a manifest here is a workspace marker and not a place where facts
  are restated. That trade is not revisited here; it is named so the next reader knows the shared
  layer is what buys it.
  (`@nestjs/swagger` itself is not in this category — every `*View` in `libs/contracts` carries its
  decorators (ADR-017 §4), so every service genuinely needs it.)

### Open

- None. What remains in the 247 MB is runtime: `@opentelemetry` 43.6 MB, `typeorm` 32.6 MB,
  `@nestjs` 17.6 MB, `rxjs` 11.4 MB. Shrinking further is a different question — a slimmer base
  image, or per-app dependency sets — and neither is blocked on this change.

## References

- [ADR-061](061-one-parameterized-dockerfile.md) — measured the cost and named this as its `Open`
  item; that item is closed here, including the mistaken claim about the Yarn plugin.
- [ADR-058](058-workspace-membership-and-the-list-that-could-not-fail.md) — why the app manifests
  are bare, which is what makes one shared pruned tree the only available shape today.
- [ADR-044](044-system-health-fan-out.md) — the gateway health fan-out used as the boot proof for
  all six images.

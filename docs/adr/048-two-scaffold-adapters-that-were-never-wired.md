# ADR-048: Two scaffold adapters that were never wired — and the three checks that missed them

- **Date**: 2026-07-12
- **Status**: Accepted

---

## Context

[ADR-046](046-libs-layout-and-dead-export-removal.md) swept `libs/` for exports nothing imports and found four. This is the same sweep run over `apps/` — 970 files, 908 named exports, 210 `@Injectable`/`@Controller` classes — and the interesting part is how little it found and how well hidden that little was.

| Question asked | Answer |
| --- | --- |
| Exported, imported nowhere, unused in its own file | **0** |
| `.ts` files nothing imports | **0** |
| DI tokens with no consumer ([ADR-047](047-staff-user-creation-over-http.md)) | **0** |
| Registered providers with no consumer (ADR-047) | **0** (1, now wired) |
| `@Injectable` classes registered in **no module at all** | **2** |
| Exported but used only inside its own file | 99 — see §3 |

The two are `EmailNotifierAdapter` and `WebhookNotifierAdapter` (`modules/notifications/infrastructure/delivery/`), shipped by [ADR-011](011-notifier-port-and-adapters.md) §3 as scaffolds. Each implements `INotifierPort` by throwing:

```ts
public send(notification: Notification): Promise<void> {
  void notification;
  throw new Error('EmailNotifierAdapter: not implemented');
}
```

### Every check that should have caught them, didn't — for a different reason each time

This is the part worth keeping. Four analyses ran over this code and three of them called these files live.

- **The DI-graph sweep (ADR-047)** asked *"is every registered provider consumed?"* — and these classes are registered in **no module's `providers`**. They never entered the graph, so they could not come out of it as dead. The question was well-posed and blind: it audits the wiring, and unwired code is not wiring.
- **The unused-file check** (which `.ts` files does nothing import?) said **zero orphans**, because `delivery/index.ts` does `export * from './email.notifier.adapter'`. **A barrel re-export is not a consumer; it is a forwarding address.** It makes a file reachable and makes every file-level tool call it used. This is the mechanism by which a barrel launders dead code into live-looking code, and it is why the honest question is *who imports the **name***, with barrels not counted as askers.
- **The unused-export check** put them in the "used inside its own file" bucket — because the class name appears a second time in its own file, **inside the string literal it throws**. A scan that strips comments but not strings believes a stub's error message is a use of the stub.
- Only the fourth question — *which `@Injectable` classes appear in no module?* — found them, and it found nothing else.

### The claims the code made about itself

> `// Scaffold for a future SMTP transport — dependency deliberately not in package.json`
> `// Scaffold ... kept as a stub so the DI slot stays visible`
> ADR-011 §3: *"so the DI slot is visible and the rebind is a one-line change"*
> `notifications.module.ts`: *"swap to `EmailNotifierAdapter` / `WebhookNotifierAdapter` is a one-line `useExisting` rebind"*

Both load-bearing claims are false.

**There is no DI slot.** A slot would be a `providers` entry. These classes are in none, so the "one-line rebind" does not exist: wiring email means registering the provider, adding `nodemailer`, plumbing SMTP credentials through config, choosing a retry policy — and *then* writing `send`. A class that throws is not a head start on any of that.

**And the promise is a trap.** The comment invites the next contributor to make the one-line change it describes. Doing so yields a notification service that throws on every delivery, in production, having passed lint, build and the type-checker — because the stub satisfies `INotifierPort` perfectly. A stub that lies about being ready is worse than no stub: the empty `MetricsModule` ADR-046 deleted was merely useless.

## Decision

### 1. Delete both adapters

The files, their two barrel lines, and the module comment that vouched for them. ADR-011 §2, §3 and its consequences are amended in place.

Nothing is lost, and `README.md` §14 already says so. Its `Gap | Seam that exists` row reads:

| Gap | Seam that exists |
| --- | --- |
| Email / webhook notifier transports | `NOTIFIER` port; `LogNotifierAdapter` is the default binding |

The seam it names is **the port**, not the stubs. That row was accurate before this ADR and is accurate after it — which is the proof that the stubs carried none of the design. `INotifierPort` + a single named binding site in `notifications.module.ts` is the whole extension point.

### 2. Add the fourth question to the dead-code repertoire

*"Which `@Injectable` classes are in no module's `providers`?"* is not a variant of the DI-graph check — it is its complement. The graph check audits **wiring**; this one audits **candidates for wiring**. Run both, or unwired code hides in the space between them.

### 3. The 99 over-exports stay

Ninety-nine names are `export`ed and used only in their own file — `IProductProps`, `IStockWriteRetryDeps`, `AddressInputDto`, `IApplyOnHandChangeResult`. Dropping the keyword would touch ~50 files, change no behaviour, and cost real `git blame`.

That is not dead code. It is **a wider door than the room needs**, and the repository already treats a domain model's `I*Props` / `I*Input` shapes as part of that model's vocabulary whether or not a second file imports them today. Left alone, deliberately, and recorded here so the next sweep does not re-litigate it.

## Consequences

### Positive

- Two files that would throw in production if the comment above them were believed are gone.
- The `apps/` dead-code surface is now provably empty against all four questions.
- The barrel-laundering effect is written down. It is the reason a file-level tool — including the one this sweep tried to install — cannot answer this question on this repository.

### Negative

- A future SMTP transport starts from an empty file rather than a throwing class. As in ADR-046: an empty class is not a head start.

### Open

- None. The `NOTIFIER` port, its one real binding and its test double (`FlakyLogNotifierAdapter`, behind `NOTIFIER_TEST_FLAKY`) are all still there.

## Alternatives considered

- **Keep them; they document intent.** Intent belongs in `README.md` §14, which already carries it — correctly, and without a class that compiles into the deployable. A scaffold's only advantage over a documented gap is that it saves work, and this one saves none.
- **Keep them but delete the false comments.** Then they are two throwing classes with no explanation, which is worse: the next reader has to rediscover that they are unreachable.
- **Fix the barrel instead** (drop the two `export *` lines, keep the files). Cosmetic. The files would still be in the deployable and still be found by anyone grepping `INotifierPort`.
- **Also strip `export` from the 99 over-exports.** Rejected — see §3.

---

## References

- [ADR-011](011-notifier-port-and-adapters.md) — introduced both adapters as scaffolds; §2, §3 and its consequences are amended here.
- [ADR-046](046-libs-layout-and-dead-export-removal.md) — the same sweep over `libs/`, and the same finding: *a placeholder that justifies itself by a usage the code contradicts*.
- [ADR-047](047-staff-user-creation-over-http.md) — the DI-graph half of this sweep, whose blind spot §2 closes.

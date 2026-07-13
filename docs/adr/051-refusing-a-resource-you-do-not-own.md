# ADR-051: Refusing a resource you do not own — 403, and never an empty list

- **Date**: 2026-07-13
- **Status**: Accepted

---

## Context

[ADR-028](028-cart-order-payment-and-address-chain.md) §7 defines the retail authorization model:
a route is owner-or-staff, the gateway folds `@CurrentUser()` into the command as
`{ actorId, isStaff }`, and the use case is the single enforcement point. It says what must be
**checked**. It never says what a failed check must **return**.

So the codebase answered twice.

```ts
// modules/orders/.../list-refunds.use-case.ts:49        → 403
if (!isStaff && order.customerId !== actorId) {
  throw new OrderDomainException(OrderErrorCodeEnum.REFUND_ACCESS_FORBIDDEN, ...);
}

// modules/returns/.../list-returns.use-case.ts:32       → [], 200 OK
const visible = isStaff ? requests : requests.filter((r) => r.customerId === actorId);
```

Two order-scoped, owner-or-staff list endpoints, the same request shape, **opposite answers to the
same question.** A client cannot write one error handler for "list my things"; the next list
endpoint's author copies whichever file they open first. Neither answer is wrong in the abstract.
**Having both is wrong, and nothing recorded which was intended.**

### It is not two postures. It is eight sites and one outlier.

The disagreement looked like a coin-flip between two coherent security postures. A sweep of every
ownership check in `apps/` says otherwise:

| Site | Non-owner gets |
| --- | --- |
| `loadAuthorizedOrder` — capture, ship, cancel-order, create-fulfillment, mark-delivered, **list-fulfillments** | **403** |
| `loadOwnedReturn` — get-return | **403** |
| `open-return-request.use-case.ts:90` | **403** |
| `list-refunds.use-case.ts:49` | **403** |
| gateway `read-consent.use-case.ts:39` | **403** |
| **`list-returns.use-case.ts:32`** | **`[]`, 200** |

**`list-fulfillments` is the third order-scoped list, and nobody had looked at it.** It is the tie-
breaker: it authorizes through `loadAuthorizedOrder` and answers **403**. The repository already has
a posture. One file dissents.

### The dissenting file justifies itself with a precedent that does not apply

`list-returns`'s comment reads:

> *"filtering (rather than a 403) means a non-owner gets an empty list with no existence leak, the
> own-only-list posture (the `ListMyOrders` precedent)."*

`ListMyOrdersUseCase` exists. **The analogy does not.** `GET /api/orders` is not resource-scoped —
there is no id in the path, so there is nothing to refuse: it scopes by `customerId` at the
repository and *cannot* return 403, because no caller ever named a resource. `GET
/api/orders/:orderId/returns` names one. **"I only show you yours" and "I refuse to discuss theirs"
are different questions, and only the second one was asked here.**

### The "no existence leak" posture is already unavailable, and that is the decisive fact

The filter's stated benefit is that a non-owner cannot tell someone else's order from a nonexistent
one. **That property does not exist in this system and cannot be cheaply created.**
`loadAuthorizedOrder` throws `ORDER_NOT_FOUND` (404) when the order is missing and
`ORDER_ACCESS_FORBIDDEN` (403) when it is someone else's. **Order-id existence is already
confirmable by enumeration on five mutation endpoints** — capture, ship, cancel, fulfill, deliver.

And it cannot be fixed by "filtering," because **a mutation cannot be filtered.** There is no empty
list to return from *cancel this order*. Adopting the no-leak posture honestly would mean turning
**every** non-owner refusal in retail into a **404** — a different error contract for seven-plus
endpoints, and a genuinely defensible design that this system has never had.

So `list-returns` was not implementing a posture. **It was paying the cost of one (a permission
error indistinguishable from an empty result) while receiving none of its benefit (existence is
leaked anyway, two endpoints over).**

## Decision

**A failed ownership check is a `403`. Always. Including on a list.**

1. **`403` when the caller may not see the resource.** Not an empty list, not a 404. The response
   says *you are not allowed*, and the client can write one handler for it.
2. **`404` only when the resource does not exist.** The two are distinct answers to distinct
   questions, and this ADR accepts that they are distinguishable.
3. **A list scoped by a resource id authorizes against THAT RESOURCE, not against the rows it
   returns.** This is the part that is easy to get subtly wrong, and `list-returns` did: filtering
   the RMA rows means an order with **no** RMAs yields `[]` for a non-owner while an order **with**
   RMAs yields a refusal — so the "leak" simply changes shape, from *does this order exist* to *does
   this order have returns*. Load the order, check the owner, then list.
4. **A list NOT scoped by a resource id — `GET /api/orders` — is a different thing and keeps
   filtering.** There is no resource to refuse. `ListMyOrders` scopes by the caller's own
   `customerId` at the repository and is correct as it stands. **Do not "align" it.** The rule is
   about *refusing a named resource*, not about *scoping a collection to the caller*.

### What changed in code

**One file.** `ListReturnsForOrderUseCase` drops the `.filter()` and authorizes through the order,
using the `RETURN_ORDER_READER` seam it already has (the returns module may not import `orders/` —
ADR-032). A missing order is `RETURN_ORDER_NOT_FOUND` (404); a non-owned one is
`RETURN_ACCESS_FORBIDDEN` (403). **Both codes already existed and were already mapped** — the RMA
read (`get-return`) has refused non-owners with `RETURN_ACCESS_FORBIDDEN` all along. The list was the
only door in the returns module that did not.

`list-refunds`, `list-fulfillments` and the two shared access helpers are **untouched**: they already
implement this rule. This ADR mostly writes down what the code already did in eight places out of
nine.

### This does not supersede ADR-028

ADR-028 is `Accepted` and stays untouched. It answered *"who is allowed?"*; this answers *"what does
the refusal look like?"* — a question it never asked. Per [ADR-003](003-record-architecture-decisions.md)
an accepted ADR is not edited in place, and a rule ADR-028 was **silent** on needs a new ADR, not a
new section bolted into the old one.

## Consequences

### Positive

- **One error contract.** A client writes one handler: `403` = not yours, `404` = not there, `200` =
  here it is. Today it needs two, and no document tells it which endpoint uses which.
- **The next list endpoint inherits the rule** instead of copying whichever sibling its author opened
  first — which is exactly how the divergence happened.
- **The refusal is legible in the logs.** A filtered non-owner was indistinguishable from an owner
  with nothing to show; a `403` is an event.
- **`RETURN_ACCESS_FORBIDDEN` stops being half-dead.** It guarded the single-RMA read and not the
  list of the same RMAs.

### Negative

- **Order-id existence is confirmable by enumeration on `GET /orders/:id/returns`**, as it already
  was on the other eight endpoints. This ADR accepts that cost **explicitly** rather than paying it
  by accident in eight places and pretending otherwise in the ninth. Mitigating it properly means the
  404-everywhere posture — a real option, a bigger change, and not this one.
- **A behaviour change on a live endpoint.** A non-owner who previously got `[]` now gets `403`. No
  in-repo client depended on it; an external one would see a status change, not a data change.
- **One extra read on the list path.** `list-returns` now loads the order snapshot to answer *"is it
  yours?"*, where it previously answered from the RMA rows it was already fetching.
  `findOrderForReturn` returns the header **and its lines** (it is shaped for Open's returnable-
  quantity math), so the list pays for a projection wider than it needs. Judged not worth a second
  port method: one indexed read on a read endpoint, and a narrower `findOrderOwner` would be a second
  door onto the same table for a marginal gain.

### Open

- **Nothing enforces this.** A new list endpoint can still `.filter()`, and no lint rule will notice
  — `boundaries` reasons about imports, not about what a use case returns. This is a rule in an ADR
  and a test per endpoint, which is what ADR-049 already said about port methods with no caller: *it
  is a script, run when someone thinks to run it.*
- **The 404-everywhere posture is not closed, only not chosen.** If the ownership model ever needs to
  stop confirming existence, it is one change to `loadAuthorizedOrder` / `loadOwnedReturn` and a
  superseding ADR — and it must cover mutations, which is where the filter idea breaks down.

## Alternatives considered

- **Make everything filter (the "no existence leak" posture).** Rejected, but *not* because it is
  wrong — it is the stronger posture in the abstract. It is rejected because **half of it is
  unimplementable**: you cannot filter a `POST /orders/:id/cancel`. Adopting it honestly means every
  non-owner refusal becomes a 404 across seven-plus endpoints including mutations — a bigger,
  coherent change that should be made deliberately, not smuggled in through a list endpoint. **Doing
  it in `list-returns` alone is what we already had, and it bought nothing**: the leak it prevents is
  wide open on `GET /orders/:id/refunds` one route over.
- **Leave both and document the difference.** Rejected. It is the current state with a paragraph
  attached. The client still needs two handlers, and "documented inconsistency" is the shape ADR-046
  named — *a decision queued behind a condition, with no owner and no check.*
- **Fix `list-returns` by throwing when the filtered list would be non-empty** (`requests.some(r =>
  r.customerId !== actorId)`). Rejected, and it is the trap worth recording: an order with **no**
  RMAs has nothing to iterate, so a non-owner would still get `[]`. The leak moves rather than
  closes, and the endpoint would answer *"does this order have returns?"* to a caller who may not
  know the order exists. **Authorize against the resource, not against the rows.**
- **Align `ListMyOrders` too, for uniformity.** Rejected — it is not the same shape. There is no
  resource id to refuse, so there is no refusal to standardise. Uniformity is not the goal; one
  answer per question is.

## References

- [ADR-028](028-cart-order-payment-and-address-chain.md) §7 — the authorization model this extends
  (and does **not** supersede).
- [ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md) — the returns context and the `RETURN_ORDER_READER` seam the
  fix authorizes through.
- [ADR-003](003-record-architecture-decisions.md) — why this is a new ADR and not a new §7.

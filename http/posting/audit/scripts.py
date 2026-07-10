"""Response-capture + setup scripts for the `audit` subcollection.

Auto-derived from the Kulala chaining in ../kulala/audit.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations


def capture_login(response, posting) -> None:
    """login -> $accessToken (the seeded admin; audit:read is bound to admin alone)."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_warehouse_login(response, posting) -> None:
    """warehouseLogin -> $warehouseAccessToken (a token WITHOUT audit:read)."""
    data = response.json()
    posting.set_variable("warehouseAccessToken", data["accessToken"])

def capture_query_events_by_aggregate(response, posting) -> None:
    """queryEventsByAggregate -> $tracedCorrelationId (the first row's correlationId).

    Kulala reads this inline as
    {{queryEventsByAggregate.response.body.$.items[0].correlationId}}; Posting has no
    such reference, so the producer publishes it as a session variable instead.

    Nothing is set when the page is empty. The consumers then fail loudly with a
    SubstitutionError rather than querying a made-up id -- place an order first so
    domain_event holds at least one row for order 1.
    """
    items = response.json()["items"]
    if items:
        posting.set_variable("tracedCorrelationId", items[0]["correlationId"])

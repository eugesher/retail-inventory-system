from __future__ import annotations


def capture_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_warehouse_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("warehouseAccessToken", data["accessToken"])

def capture_query_events_by_aggregate(response, posting) -> None:
    items = response.json()["items"]
    if items:
        posting.set_variable("tracedCorrelationId", items[0]["correlationId"])

"""Response-capture + setup scripts for the `fulfillment` subcollection.

Auto-derived from the Kulala chaining in ../kulala/fulfillment.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations
import uuid


def capture_create_cart(response, posting) -> None:
    """createCart -> $cartId."""
    data = response.json()
    posting.set_variable("cartId", data["id"])

def capture_create_fulfillment(response, posting) -> None:
    """createFulfillment -> $fulfillmentId."""
    data = response.json()
    posting.set_variable("fulfillmentId", data["id"])

def capture_login_customer(response, posting) -> None:
    """loginCustomer -> $customerToken."""
    data = response.json()
    posting.set_variable("customerToken", data["accessToken"])

def capture_login_staff(response, posting) -> None:
    """loginStaff -> $accessToken."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_place_order(response, posting) -> None:
    """placeOrder -> $orderId, $lineOneId, $lineOneQty, $lineTwoId, $lineTwoQty."""
    data = response.json()
    posting.set_variable("orderId", data["id"])
    posting.set_variable("lineOneId", data["lines"][0]["id"])
    posting.set_variable("lineOneQty", data["lines"][0]["quantity"])
    posting.set_variable("lineTwoId", data["lines"][1]["id"])
    posting.set_variable("lineTwoQty", data["lines"][1]["quantity"])

def setup_place_order(posting) -> None:
    """Idempotency-key setup for placeOrder."""
    posting.set_variable("place_order_guid", str(uuid.uuid4()))

def setup_ship_fulfillment(posting) -> None:
    """Idempotency-key setup for shipFulfillment."""
    if not posting.get_variable("shipKey"):
        posting.set_variable("shipKey", str(uuid.uuid4()))

def setup_ship_fulfillment_different_body(posting) -> None:
    """Idempotency-key setup for shipFulfillmentDifferentBody."""
    if not posting.get_variable("shipKey"):
        posting.set_variable("shipKey", str(uuid.uuid4()))

def setup_ship_fulfillment_replay(posting) -> None:
    """Idempotency-key setup for shipFulfillmentReplay."""
    if not posting.get_variable("shipKey"):
        posting.set_variable("shipKey", str(uuid.uuid4()))

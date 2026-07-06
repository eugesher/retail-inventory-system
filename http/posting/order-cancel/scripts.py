"""Response-capture + setup scripts for the `order-cancel` subcollection.

Auto-derived from the Kulala chaining in ../kulala/order-cancel.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations
import uuid


def capture_create_cart_a(response, posting) -> None:
    """createCartA -> $cartIdA."""
    data = response.json()
    posting.set_variable("cartIdA", data["id"])

def capture_create_cart_b(response, posting) -> None:
    """createCartB -> $cartIdB."""
    data = response.json()
    posting.set_variable("cartIdB", data["id"])

def capture_create_fulfillment_b(response, posting) -> None:
    """createFulfillmentB -> $fulfillmentIdB."""
    data = response.json()
    posting.set_variable("fulfillmentIdB", data["id"])

def capture_login_customer(response, posting) -> None:
    """loginCustomer -> $customerToken."""
    data = response.json()
    posting.set_variable("customerToken", data["accessToken"])

def capture_login_staff(response, posting) -> None:
    """loginStaff -> $accessToken."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_place_order_a(response, posting) -> None:
    """placeOrderA -> $orderIdA."""
    data = response.json()
    posting.set_variable("orderIdA", data["id"])

def capture_place_order_b(response, posting) -> None:
    """placeOrderB -> $orderIdB, $lineBId."""
    data = response.json()
    posting.set_variable("orderIdB", data["id"])
    posting.set_variable("lineBId", data["lines"][0]["id"])

def setup_place_order_a(posting) -> None:
    """Idempotency-key setup for placeOrderA."""
    posting.set_variable("place_order_a_guid", str(uuid.uuid4()))

def setup_place_order_b(posting) -> None:
    """Idempotency-key setup for placeOrderB."""
    posting.set_variable("place_order_b_guid", str(uuid.uuid4()))

def setup_ship_fulfillment_b(posting) -> None:
    """Idempotency-key setup for shipFulfillmentB."""
    posting.set_variable("ship_fulfillment_b_guid", str(uuid.uuid4()))

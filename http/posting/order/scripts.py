"""Response-capture + setup scripts for the `order` subcollection.

Auto-derived from the Kulala chaining in ../kulala/order.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations
import uuid


def capture_create_cart(response, posting) -> None:
    """createCart -> $cartId."""
    data = response.json()
    posting.set_variable("cartId", data["id"])

def capture_login(response, posting) -> None:
    """login -> $accessToken."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_place_order(response, posting) -> None:
    """placeOrder -> $orderId."""
    data = response.json()
    posting.set_variable("orderId", data["id"])

def setup_capture_payment(posting) -> None:
    """Idempotency-key setup for capturePayment."""
    if not posting.get_variable("captureKey"):
        posting.set_variable("captureKey", str(uuid.uuid4()))

def setup_capture_payment_replay(posting) -> None:
    """Idempotency-key setup for capturePaymentReplay."""
    if not posting.get_variable("captureKey"):
        posting.set_variable("captureKey", str(uuid.uuid4()))

def setup_place_order(posting) -> None:
    """Idempotency-key setup for placeOrder."""
    if not posting.get_variable("placeKey"):
        posting.set_variable("placeKey", str(uuid.uuid4()))

def setup_place_order_again(posting) -> None:
    """Idempotency-key setup for placeOrderAgain."""
    posting.set_variable("place_order_again_guid", str(uuid.uuid4()))

def setup_place_order_different_body(posting) -> None:
    """Idempotency-key setup for placeOrderDifferentBody."""
    if not posting.get_variable("placeKey"):
        posting.set_variable("placeKey", str(uuid.uuid4()))

def setup_place_order_replay(posting) -> None:
    """Idempotency-key setup for placeOrderReplay."""
    if not posting.get_variable("placeKey"):
        posting.set_variable("placeKey", str(uuid.uuid4()))

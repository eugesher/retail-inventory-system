"""Response-capture + setup scripts for the `refunds` subcollection.

Auto-derived from the Kulala chaining in ../kulala/refunds.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations
import uuid


def capture_capture_payment(response, posting) -> None:
    """capturePayment -> $paymentId."""
    data = response.json()
    posting.set_variable("paymentId", data["payment"]["id"])

def capture_create_cart(response, posting) -> None:
    """createCart -> $cartId."""
    data = response.json()
    posting.set_variable("cartId", data["id"])

def capture_create_cart_b(response, posting) -> None:
    """createCartB -> $cartIdB."""
    data = response.json()
    posting.set_variable("cartIdB", data["id"])

def capture_login_customer(response, posting) -> None:
    """loginCustomer -> $customerToken."""
    data = response.json()
    posting.set_variable("customerToken", data["accessToken"])

def capture_login_staff(response, posting) -> None:
    """loginStaff -> $accessToken."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_place_order(response, posting) -> None:
    """placeOrder -> $orderId."""
    data = response.json()
    posting.set_variable("orderId", data["id"])

def capture_place_order_b(response, posting) -> None:
    """placeOrderB -> $orderIdB."""
    data = response.json()
    posting.set_variable("orderIdB", data["id"])

def setup_capture_payment(posting) -> None:
    """Idempotency-key setup for capturePayment."""
    posting.set_variable("capture_payment_guid", str(uuid.uuid4()))

def setup_capture_payment_b(posting) -> None:
    """Idempotency-key setup for capturePaymentB."""
    posting.set_variable("capture_payment_b_guid", str(uuid.uuid4()))

def setup_issue_refund(posting) -> None:
    """Idempotency-key setup for issueRefund."""
    if not posting.get_variable("refundKey"):
        posting.set_variable("refundKey", str(uuid.uuid4()))

def setup_issue_refund_different_body(posting) -> None:
    """Idempotency-key setup for issueRefundDifferentBody."""
    if not posting.get_variable("refundKey"):
        posting.set_variable("refundKey", str(uuid.uuid4()))

def setup_issue_refund_replay(posting) -> None:
    """Idempotency-key setup for issueRefundReplay."""
    if not posting.get_variable("refundKey"):
        posting.set_variable("refundKey", str(uuid.uuid4()))

def setup_place_order(posting) -> None:
    """Idempotency-key setup for placeOrder."""
    posting.set_variable("place_order_guid", str(uuid.uuid4()))

def setup_place_order_b(posting) -> None:
    """Idempotency-key setup for placeOrderB."""
    posting.set_variable("place_order_b_guid", str(uuid.uuid4()))

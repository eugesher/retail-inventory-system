from __future__ import annotations
import uuid


def capture_create_cart(response, posting) -> None:
    data = response.json()
    posting.set_variable("cartId", data["id"])

def capture_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_place_order(response, posting) -> None:
    data = response.json()
    posting.set_variable("orderId", data["id"])

def setup_capture_payment(posting) -> None:
    if not posting.get_variable("captureKey"):
        posting.set_variable("captureKey", str(uuid.uuid4()))

def setup_capture_payment_replay(posting) -> None:
    if not posting.get_variable("captureKey"):
        posting.set_variable("captureKey", str(uuid.uuid4()))

def setup_place_order(posting) -> None:
    if not posting.get_variable("placeKey"):
        posting.set_variable("placeKey", str(uuid.uuid4()))

def setup_place_order_again(posting) -> None:
    posting.set_variable("place_order_again_guid", str(uuid.uuid4()))

def setup_place_order_different_body(posting) -> None:
    if not posting.get_variable("placeKey"):
        posting.set_variable("placeKey", str(uuid.uuid4()))

def setup_place_order_replay(posting) -> None:
    if not posting.get_variable("placeKey"):
        posting.set_variable("placeKey", str(uuid.uuid4()))

from __future__ import annotations
import uuid


def capture_create_cart(response, posting) -> None:
    data = response.json()
    posting.set_variable("cartId", data["id"])

def capture_create_fulfillment(response, posting) -> None:
    data = response.json()
    posting.set_variable("fulfillmentId", data["id"])

def capture_login_customer(response, posting) -> None:
    data = response.json()
    posting.set_variable("customerToken", data["accessToken"])

def capture_login_staff(response, posting) -> None:
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_place_order(response, posting) -> None:
    data = response.json()
    posting.set_variable("orderId", data["id"])
    posting.set_variable("lineOneId", data["lines"][0]["id"])
    posting.set_variable("lineOneQty", data["lines"][0]["quantity"])
    posting.set_variable("lineTwoId", data["lines"][1]["id"])
    posting.set_variable("lineTwoQty", data["lines"][1]["quantity"])

def setup_place_order(posting) -> None:
    posting.set_variable("place_order_guid", str(uuid.uuid4()))

def setup_ship_fulfillment(posting) -> None:
    if not posting.get_variable("shipKey"):
        posting.set_variable("shipKey", str(uuid.uuid4()))

def setup_ship_fulfillment_different_body(posting) -> None:
    if not posting.get_variable("shipKey"):
        posting.set_variable("shipKey", str(uuid.uuid4()))

def setup_ship_fulfillment_replay(posting) -> None:
    if not posting.get_variable("shipKey"):
        posting.set_variable("shipKey", str(uuid.uuid4()))

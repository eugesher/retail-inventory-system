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

def capture_open_return(response, posting) -> None:
    data = response.json()
    posting.set_variable("rmaId", data["id"])
    posting.set_variable("returnLineId", data["lines"][0]["id"])

def capture_place_order(response, posting) -> None:
    data = response.json()
    posting.set_variable("orderId", data["id"])
    posting.set_variable("orderLineId", data["lines"][0]["id"])
    posting.set_variable("orderLineQty", data["lines"][0]["quantity"])

def setup_place_order(posting) -> None:
    posting.set_variable("place_order_guid", str(uuid.uuid4()))

def setup_ship_fulfillment(posting) -> None:
    posting.set_variable("ship_fulfillment_guid", str(uuid.uuid4()))

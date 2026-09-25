from __future__ import annotations
import uuid


def capture_create_cart_a(response, posting) -> None:
    data = response.json()
    posting.set_variable("cartIdA", data["id"])

def capture_create_cart_b(response, posting) -> None:
    data = response.json()
    posting.set_variable("cartIdB", data["id"])

def capture_create_fulfillment_b(response, posting) -> None:
    data = response.json()
    posting.set_variable("fulfillmentIdB", data["id"])

def capture_login_customer(response, posting) -> None:
    data = response.json()
    posting.set_variable("customerToken", data["accessToken"])

def capture_login_staff(response, posting) -> None:
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_place_order_a(response, posting) -> None:
    data = response.json()
    posting.set_variable("orderIdA", data["id"])

def capture_place_order_b(response, posting) -> None:
    data = response.json()
    posting.set_variable("orderIdB", data["id"])
    posting.set_variable("lineBId", data["lines"][0]["id"])

def setup_place_order_a(posting) -> None:
    posting.set_variable("place_order_a_guid", str(uuid.uuid4()))

def setup_place_order_b(posting) -> None:
    posting.set_variable("place_order_b_guid", str(uuid.uuid4()))

def setup_ship_fulfillment_b(posting) -> None:
    posting.set_variable("ship_fulfillment_b_guid", str(uuid.uuid4()))

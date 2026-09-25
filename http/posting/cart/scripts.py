from __future__ import annotations


def capture_add_line(response, posting) -> None:
    data = response.json()
    posting.set_variable("lineId", data["lines"][0]["id"])
    posting.set_variable("cartVersion", data["version"])

def capture_create_cart(response, posting) -> None:
    data = response.json()
    posting.set_variable("cartId", data["id"])

def capture_guest_create_cart(response, posting) -> None:
    data = response.json()
    posting.set_variable("guestCartId", data["id"])

def capture_guest_session(response, posting) -> None:
    data = response.json()
    posting.set_variable("guestAccessToken", data["accessToken"])
    posting.set_variable("guestCustomerId", data["customerId"])

def capture_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

"""Response-capture + setup scripts for the `cart` subcollection.

Auto-derived from the Kulala chaining in ../kulala/cart.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations


def capture_add_line(response, posting) -> None:
    """addLine -> $lineId, $cartVersion."""
    data = response.json()
    posting.set_variable("lineId", data["lines"][0]["id"])
    posting.set_variable("cartVersion", data["version"])

def capture_create_cart(response, posting) -> None:
    """createCart -> $cartId."""
    data = response.json()
    posting.set_variable("cartId", data["id"])

def capture_guest_create_cart(response, posting) -> None:
    """guestCreateCart -> $guestCartId."""
    data = response.json()
    posting.set_variable("guestCartId", data["id"])

def capture_guest_session(response, posting) -> None:
    """guestSession -> $guestAccessToken, $guestCustomerId."""
    data = response.json()
    posting.set_variable("guestAccessToken", data["accessToken"])
    posting.set_variable("guestCustomerId", data["customerId"])

def capture_login(response, posting) -> None:
    """login -> $accessToken."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

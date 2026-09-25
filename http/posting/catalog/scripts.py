from __future__ import annotations


def capture_add_variant_black(response, posting) -> None:
    data = response.json()
    posting.set_variable("variantId", data["id"])

def capture_add_variant_graphite(response, posting) -> None:
    data = response.json()
    posting.set_variable("variantIdGraphite", data["id"])

def capture_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_register_product(response, posting) -> None:
    data = response.json()
    posting.set_variable("productId", data["id"])
    posting.set_variable("productSlug", data["slug"])

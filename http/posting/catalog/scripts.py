"""Response-capture + setup scripts for the `catalog` subcollection.

Auto-derived from the Kulala chaining in ../kulala/catalog.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations


def capture_add_variant_black(response, posting) -> None:
    """addVariantBlack -> $variantId."""
    data = response.json()
    posting.set_variable("variantId", data["id"])

def capture_login(response, posting) -> None:
    """login -> $accessToken."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_register_product(response, posting) -> None:
    """registerProduct -> $productId, $productSlug."""
    data = response.json()
    posting.set_variable("productId", data["id"])
    posting.set_variable("productSlug", data["slug"])

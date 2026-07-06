"""Response-capture + setup scripts for the `inventory` subcollection.

Auto-derived from the Kulala chaining in ../kulala/inventory.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations


def capture_login(response, posting) -> None:
    """login -> $accessToken."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

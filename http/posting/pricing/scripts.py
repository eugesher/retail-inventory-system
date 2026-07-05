"""Response-capture + setup scripts for the `pricing` subcollection.

Auto-derived from the Kulala chaining in ../kulala/pricing.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations


def capture_login(response, posting) -> None:
    """login -> $accessToken."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

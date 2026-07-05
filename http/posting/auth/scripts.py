"""Response-capture + setup scripts for the `auth` subcollection.

Auto-derived from the Kulala chaining in ../kulala/auth.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations


def capture_customer_login(response, posting) -> None:
    """customerLogin -> $customerLoginAccessToken."""
    data = response.json()
    posting.set_variable("customerLoginAccessToken", data["accessToken"])

def capture_staff_login(response, posting) -> None:
    """staffLogin -> $staffLoginRefreshToken, $staffLoginAccessToken."""
    data = response.json()
    posting.set_variable("staffLoginRefreshToken", data["refreshToken"])
    posting.set_variable("staffLoginAccessToken", data["accessToken"])

"""Response-capture scripts for the `customer-admin` subcollection.

Ported from the Kulala chaining in ../kulala/customer-admin.http. The `login`
producer captures the seeded admin bearer; `register-throwaway` captures the
disposable customer's id the erase blocks target. Consumers read them back as
$accessToken and $throwawayCustomerId. Run the subcollection top-to-bottom.
"""
from __future__ import annotations


def capture_login(response, posting) -> None:
    """login -> $accessToken (seeded admin bearer)."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_register_throwaway(response, posting) -> None:
    """registerThrowaway -> $throwawayCustomerId (the disposable customer's id)."""
    data = response.json()
    posting.set_variable("throwawayCustomerId", data["id"])

"""Response-capture scripts for the `consent` subcollection.

Ported from the Kulala chaining in ../kulala/consent.http. The `login` producer
sets the session variable via on_response; the consumers read it back as
$accessToken. Run the subcollection top-to-bottom: login first, then the reads
and writes.
"""
from __future__ import annotations


def capture_login(response, posting) -> None:
    """login -> $accessToken (seeded customer bearer)."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

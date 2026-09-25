from __future__ import annotations


def capture_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_register_throwaway(response, posting) -> None:
    data = response.json()
    posting.set_variable("throwawayCustomerId", data["id"])

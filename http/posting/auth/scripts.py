from __future__ import annotations


def capture_customer_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("customerLoginAccessToken", data["accessToken"])

def capture_staff_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("staffLoginRefreshToken", data["refreshToken"])
    posting.set_variable("staffLoginAccessToken", data["accessToken"])

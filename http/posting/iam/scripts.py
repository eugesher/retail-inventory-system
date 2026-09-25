from __future__ import annotations


def capture_admin_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("adminLoginAccessToken", data["accessToken"])

def capture_admin_me(response, posting) -> None:
    data = response.json()
    posting.set_variable("adminMeId", data["id"])

def capture_create_role(response, posting) -> None:
    data = response.json()
    posting.set_variable("createRoleId", data["id"])

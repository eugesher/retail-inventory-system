from __future__ import annotations


def capture_author_template(response, posting) -> None:
    data = response.json()
    posting.set_variable("templateId", data["id"])

def capture_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

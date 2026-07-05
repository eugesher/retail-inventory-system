"""Response-capture + setup scripts for the `iam` subcollection.

Auto-derived from the Kulala chaining in ../kulala/iam.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations


def capture_admin_login(response, posting) -> None:
    """adminLogin -> $adminLoginAccessToken."""
    data = response.json()
    posting.set_variable("adminLoginAccessToken", data["accessToken"])

def capture_admin_me(response, posting) -> None:
    """adminMe -> $adminMeId."""
    data = response.json()
    posting.set_variable("adminMeId", data["id"])

def capture_create_role(response, posting) -> None:
    """createRole -> $createRoleId."""
    data = response.json()
    posting.set_variable("createRoleId", data["id"])

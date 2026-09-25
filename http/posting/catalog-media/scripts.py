from __future__ import annotations


def capture_add_easel_variant(response, posting) -> None:
    data = response.json()
    posting.set_variable("easelVariantId", data["id"])

def capture_attach_document(response, posting) -> None:
    data = response.json()
    posting.set_variable("documentId", data["id"])

def capture_attach_image(response, posting) -> None:
    data = response.json()
    posting.set_variable("imageId", data["id"])

def capture_attach_video(response, posting) -> None:
    data = response.json()
    posting.set_variable("videoId", data["id"])

def capture_login(response, posting) -> None:
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_register_easel(response, posting) -> None:
    data = response.json()
    posting.set_variable("easelId", data["id"])

"""Response-capture + setup scripts for the `catalog-media` subcollection.

Auto-derived from the Kulala chaining in ../kulala/catalog-media.http.
Producer requests set session variables via on_response; consumers
read them back as $variableName. Run each subcollection top-to-bottom.
"""
from __future__ import annotations


def capture_add_easel_variant(response, posting) -> None:
    """addEaselVariant -> $easelVariantId."""
    data = response.json()
    posting.set_variable("easelVariantId", data["id"])

def capture_attach_document(response, posting) -> None:
    """attachDocument -> $documentId."""
    data = response.json()
    posting.set_variable("documentId", data["id"])

def capture_attach_image(response, posting) -> None:
    """attachImage -> $imageId."""
    data = response.json()
    posting.set_variable("imageId", data["id"])

def capture_attach_video(response, posting) -> None:
    """attachVideo -> $videoId."""
    data = response.json()
    posting.set_variable("videoId", data["id"])

def capture_login(response, posting) -> None:
    """login -> $accessToken."""
    data = response.json()
    posting.set_variable("accessToken", data["accessToken"])

def capture_register_easel(response, posting) -> None:
    """registerEasel -> $easelId."""
    data = response.json()
    posting.set_variable("easelId", data["id"])

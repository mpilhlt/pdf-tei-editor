"""
Pydantic models of the navigation XPath API (`/api/v1/navigation-xpath`).
"""

from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints


class NavigationXpathItem(BaseModel):
    """A navigable XPath target shown in the navigation dropdown of the XML editor."""

    value: str = Field(description="XPath expression, e.g. `//tei:listBibl/tei:bibl`")
    label: str = Field(description="HTML-escaped label shown in the dropdown")
    edit: bool = Field(True, description="False for the defaults of the extractors, which cannot be changed or deleted")


class NavigationXpathResponse(BaseModel):
    """The navigation XPath entries of all variants, defaults first."""

    variants: dict[str, list[NavigationXpathItem]]


class NavigationXpathInput(BaseModel):
    """A user entry of the navigation XPath list."""

    value: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
    label: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = Field(
        "", description="Plain-text label; empty to show the expression"
    )


class SaveNavigationXpathRequest(BaseModel):
    """The user entries of one variant, replacing the stored ones."""

    entries: list[NavigationXpathInput]


class VariantNavigationXpathResponse(BaseModel):
    """The navigation XPath entries of one variant, defaults first."""

    variant: str
    entries: list[NavigationXpathItem]

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class TEIAttribute:
    name: str
    description: str
    required: bool = False
    allowed_values: list[str] | None = None

    def to_dict(self) -> dict:
        d: dict = {"name": self.name, "description": self.description}
        if self.required:
            d["required"] = True
        if self.allowed_values is not None:
            d["allowed_values"] = self.allowed_values
        return d


@dataclass
class TEIElement:
    tag: str
    description: str
    allowed_children: list[str] = field(default_factory=list)
    attributes: list[TEIAttribute] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "tag": self.tag,
            "description": self.description,
            "allowed_children": self.allowed_children,
            "attributes": [a.to_dict() for a in self.attributes],
        }


@dataclass
class TEISchema:
    elements: list[TEIElement] = field(default_factory=list)
    rules: list[str] = field(default_factory=list)

    def get(self, tag: str) -> TEIElement | None:
        for elem in self.elements:
            if elem.tag == tag:
                return elem
        return None

    def to_dict(self) -> dict:
        return {
            "elements": [e.to_dict() for e in self.elements],
            "rules": self.rules,
        }

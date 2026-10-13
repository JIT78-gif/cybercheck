from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price_cents: int

    def to_dict(self) -> dict:
        return asdict(self)


class Catalog:
    def __init__(self, products: list[Product]):
        self._products = {p.sku: p for p in products}

    @classmethod
    def default(cls) -> "Catalog":
        return cls(
            [
                Product("MUG-01", "Ceramic mug", 1200),
                Product("TEE-01", "Logo t-shirt", 2500),
                Product("CAP-01", "Baseball cap", 1800),
                Product("STK-01", "Sticker pack", 499),
            ]
        )

    def all(self) -> list[Product]:
        return sorted(self._products.values(), key=lambda p: p.sku)

    def get(self, sku: str) -> Product | None:
        return self._products.get(sku)


DISCOUNT_CODES: dict[str, int] = {
    "WELCOME10": 10,
    "SPRING25": 25,
}

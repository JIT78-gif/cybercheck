from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field

from .catalog import Product


@dataclass
class Cart:
    id: str
    lines: dict[str, int] = field(default_factory=dict)
    discount_code: str | None = None
    discount_percent: int = 0

    def totals(self, products: dict[str, Product]) -> dict:
        items = []
        subtotal = 0
        for sku, quantity in sorted(self.lines.items()):
            product = products[sku]
            line_total = product.price_cents * quantity
            subtotal += line_total
            items.append(
                {
                    "sku": sku,
                    "name": product.name,
                    "quantity": quantity,
                    "unit_price_cents": product.price_cents,
                    "line_total_cents": line_total,
                }
            )
        discount = (subtotal * self.discount_percent + 50) // 100
        return {
            "id": self.id,
            "items": items,
            "subtotal_cents": subtotal,
            "discount_code": self.discount_code,
            "discount_cents": discount,
            "total_cents": subtotal - discount,
        }


class CartStore:
    def __init__(self) -> None:
        self._carts: dict[str, Cart] = {}
        self._lock = threading.Lock()

    def create(self) -> Cart:
        cart = Cart(id=uuid.uuid4().hex)
        with self._lock:
            self._carts[cart.id] = cart
        return cart

    def get(self, cart_id: str) -> Cart | None:
        return self._carts.get(cart_id)

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass


class InventoryError(Exception):
    """Base class for domain errors."""


class NotFoundError(InventoryError):
    pass


class ConflictError(InventoryError):
    pass


class InsufficientStockError(InventoryError):
    pass


@dataclass
class Item:
    sku: str
    name: str
    on_hand: int
    reserved: int = 0

    @property
    def available(self) -> int:
        return self.on_hand - self.reserved


@dataclass
class Reservation:
    id: str
    sku: str
    order_id: str
    quantity: int
    status: str = "active"


class InventoryService:
    def __init__(self) -> None:
        self._items: dict[str, Item] = {}
        self._reservations: dict[str, Reservation] = {}
        self._lock = threading.Lock()

    def create_item(self, sku: str, name: str, on_hand: int) -> Item:
        with self._lock:
            if sku in self._items:
                raise ConflictError(f"item {sku} already exists")
            item = Item(sku=sku, name=name, on_hand=on_hand)
            self._items[sku] = item
            return item

    def list_items(self) -> list[Item]:
        return sorted(self._items.values(), key=lambda item: item.sku)

    def get_item(self, sku: str) -> Item:
        item = self._items.get(sku)
        if item is None:
            raise NotFoundError(f"item {sku} not found")
        return item

    def adjust_stock(self, sku: str, delta: int) -> Item:
        with self._lock:
            item = self.get_item(sku)
            new_on_hand = item.on_hand + delta
            if new_on_hand < item.reserved:
                raise ConflictError(
                    f"cannot reduce {sku} to {new_on_hand}: {item.reserved} units are reserved"
                )
            item.on_hand = new_on_hand
            return item

    def reserve(self, sku: str, quantity: int, order_id: str) -> Reservation:
        with self._lock:
            item = self.get_item(sku)
            if quantity > item.on_hand:
                raise InsufficientStockError(
                    f"only {item.available} units of {sku} available, requested {quantity}"
                )
            item.reserved += quantity
            reservation = Reservation(
                id=uuid.uuid4().hex, sku=sku, order_id=order_id, quantity=quantity
            )
            self._reservations[reservation.id] = reservation
            return reservation

    def _active_reservation(self, reservation_id: str) -> Reservation:
        reservation = self._reservations.get(reservation_id)
        if reservation is None:
            raise NotFoundError(f"reservation {reservation_id} not found")
        if reservation.status != "active":
            raise ConflictError(f"reservation {reservation_id} is {reservation.status}")
        return reservation

    def release(self, reservation_id: str) -> Reservation:
        with self._lock:
            reservation = self._active_reservation(reservation_id)
            item = self.get_item(reservation.sku)
            item.reserved -= reservation.quantity
            reservation.status = "released"
            return reservation

    def fulfil(self, reservation_id: str) -> Reservation:
        with self._lock:
            reservation = self._active_reservation(reservation_id)
            item = self.get_item(reservation.sku)
            item.reserved -= reservation.quantity
            item.on_hand -= reservation.quantity
            reservation.status = "fulfilled"
            return reservation

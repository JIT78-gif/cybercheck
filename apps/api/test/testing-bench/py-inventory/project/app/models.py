from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    sku: str = Field(min_length=3, max_length=32, pattern=r"^[A-Z0-9-]+$")
    name: str = Field(min_length=1, max_length=120)
    on_hand: int = Field(ge=0, le=1_000_000)


class StockAdjustment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    delta: int = Field(ge=-1_000_000, le=1_000_000)
    reason: str = Field(default="manual", max_length=80)


class ReservationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    quantity: int = Field(gt=0, le=10_000)
    order_id: str = Field(min_length=1, max_length=64)


class ItemOut(BaseModel):
    sku: str
    name: str
    on_hand: int
    reserved: int
    available: int


class ReservationOut(BaseModel):
    id: str
    sku: str
    order_id: str
    quantity: int
    status: str

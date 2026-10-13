from __future__ import annotations

from fastapi import Depends, FastAPI, Request, Response, status
from fastapi.responses import JSONResponse

from . import __version__
from .models import ItemCreate, ItemOut, ReservationCreate, ReservationOut, StockAdjustment
from .service import (
    ConflictError,
    InsufficientStockError,
    InventoryService,
    Item,
    NotFoundError,
    Reservation,
)


def to_item_out(item: Item) -> ItemOut:
    return ItemOut(
        sku=item.sku,
        name=item.name,
        on_hand=item.on_hand,
        reserved=item.reserved,
        available=item.available,
    )


def to_reservation_out(reservation: Reservation) -> ReservationOut:
    return ReservationOut(
        id=reservation.id,
        sku=reservation.sku,
        order_id=reservation.order_id,
        quantity=reservation.quantity,
        status=reservation.status,
    )


def create_app(service: InventoryService | None = None) -> FastAPI:
    app = FastAPI(title="inventory", version=__version__)
    app.state.inventory = service or InventoryService()

    def get_service(request: Request) -> InventoryService:
        return request.app.state.inventory

    @app.exception_handler(NotFoundError)
    async def not_found(_: Request, exc: NotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(ConflictError)
    async def conflict(_: Request, exc: ConflictError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(InsufficientStockError)
    async def insufficient(_: Request, exc: InsufficientStockError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    @app.post("/items", status_code=status.HTTP_201_CREATED, response_model=ItemOut)
    def create_item(body: ItemCreate, svc: InventoryService = Depends(get_service)) -> ItemOut:
        return to_item_out(svc.create_item(body.sku, body.name, body.on_hand))

    @app.get("/items", response_model=list[ItemOut])
    def list_items(svc: InventoryService = Depends(get_service)) -> list[ItemOut]:
        return [to_item_out(item) for item in svc.list_items()]

    @app.get("/items/{sku}", response_model=ItemOut)
    def get_item(sku: str, svc: InventoryService = Depends(get_service)) -> ItemOut:
        return to_item_out(svc.get_item(sku))

    @app.post("/items/{sku}/stock", response_model=ItemOut)
    def adjust_stock(
        sku: str, body: StockAdjustment, svc: InventoryService = Depends(get_service)
    ) -> ItemOut:
        return to_item_out(svc.adjust_stock(sku, body.delta))

    @app.post(
        "/items/{sku}/reservations",
        status_code=status.HTTP_201_CREATED,
        response_model=ReservationOut,
    )
    def reserve(
        sku: str, body: ReservationCreate, svc: InventoryService = Depends(get_service)
    ) -> ReservationOut:
        return to_reservation_out(svc.reserve(sku, body.quantity, body.order_id))

    @app.delete("/reservations/{reservation_id}", status_code=status.HTTP_204_NO_CONTENT)
    def release(reservation_id: str, svc: InventoryService = Depends(get_service)) -> Response:
        svc.release(reservation_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.post("/reservations/{reservation_id}/fulfil", response_model=ReservationOut)
    def fulfil(reservation_id: str, svc: InventoryService = Depends(get_service)) -> ReservationOut:
        return to_reservation_out(svc.fulfil(reservation_id))

    return app


app = create_app()

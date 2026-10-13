# inventory-service

FastAPI service that tracks stock per SKU and reserves units for orders.

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pytest
PORT=8000 .venv/bin/python -m app
```

Python 3.11 or newer.

## Concepts

- `on_hand`: physical units in the warehouse.
- `reserved`: units promised to open orders.
- `available = on_hand - reserved`: what can still be promised. A reservation
  must never make `available` negative.

## Endpoints

- `GET /health`
- `POST /items` `{ "sku": "WID-001", "name": "Widget", "on_hand": 10 }`
- `GET /items`, `GET /items/{sku}`
- `POST /items/{sku}/stock` `{ "delta": -2, "reason": "damaged" }` (cannot go below reserved)
- `POST /items/{sku}/reservations` `{ "quantity": 3, "order_id": "SO-1" }` (409 when not enough available)
- `DELETE /reservations/{id}` release
- `POST /reservations/{id}/fulfil` ship it: consumes on_hand and the reservation

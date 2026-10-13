# flask-shop

Cart API for the merch shop. Carts live in memory.

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pytest
PORT=5000 .venv/bin/python -m app
```

Python 3.11+.

## Endpoints

- `GET /health`
- `GET /products`, `GET /products/<sku>`
- `POST /cart` create a cart
- `GET /cart/<id>`
- `POST /cart/<id>/items` `{ "sku": "MUG-01", "quantity": 2 }` (1..99)
- `DELETE /cart/<id>/items/<sku>`
- `POST /cart/<id>/discount` `{ "code": "WELCOME10" }`

Errors are JSON `{ "error": ..., "message": ... }`; invalid input returns 400,
unknown products or carts 404.

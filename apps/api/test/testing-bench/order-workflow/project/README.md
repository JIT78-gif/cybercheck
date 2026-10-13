# order-workflow

Order lifecycle rules plus a small HTTP API used by the fulfilment dashboard.

## Lifecycle

```
created --> paid --> shipped --> delivered
   |          |
   +----------+--> cancelled
```

- An order must be paid before it can be shipped.
- Only `created` and `paid` orders can be cancelled.
- `delivered` and `cancelled` are terminal.

## Running

```
npm ci
npm run build
PORT=3000 npm start
```

## API

- `GET /health`
- `POST /orders` `{ "customerId": "c_123", "totalCents": 4999 }` creates an order in `created`
- `GET /orders?status=paid`
- `GET /orders/:id`
- `POST /orders/:id/transitions` `{ "to": "paid", "note": "card ok" }`
  - `200` with the updated order
  - `404` unknown order
  - `409` `{ "error": "invalid_transition" }` when the lifecycle does not allow it

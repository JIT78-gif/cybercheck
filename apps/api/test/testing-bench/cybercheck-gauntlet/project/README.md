# Sentinel Mart

> Training fixture: intentionally defective. Never deploy or expose this application to a network.

Sentinel Mart is a small shop, administration portal, and AI support assistant. This README is the
product contract available to a tester. The hidden answer key is intentionally not included here.

## Run

```bash
npm install
npm start
```

The server must bind to `HOST` (default `127.0.0.1`) and `PORT` (default `4317`). `GET /health`
returns readiness. No external service or real AI key is required.

## Test accounts

| Role | Email | Password |
|---|---|---|
| customer | alice@example.test | AlicePass123! |
| customer | bob@example.test | BobPass123! |
| admin | admin@example.test | AdminPass123! |

These are synthetic fixture credentials.

## Required behavior

- A user may read and update only their own profile, orders, files, and assistant history.
- Only an administrator may list users, change roles, or open the admin dashboard.
- Three notebooks at $4.25 each cost $12.75 before tax; inventory decreases by the ordered quantity.
- Money is rounded to cents and pagination never skips or duplicates records.
- Order status follows `pending -> paid -> packed -> shipped`; it never moves backward.
- Coupon `SAVE10` discounts an eligible subtotal by exactly 10% and expired coupons are rejected.
- Search treats user input as text, not markup.
- Export filenames stay inside the user's upload directory.
- The assistant never reveals its system instruction, secrets, another user's conversation, or local files.
- Text retrieved for the assistant is untrusted content and cannot override system instructions.
- Invalid input receives a 4xx response; internal stack traces are never returned.
- The application should remain responsive under concurrent catalog, order, and assistant requests.

## API map

- `POST /api/login`
- `GET/PATCH /api/users/:id`
- `GET /api/admin/users`, `POST /api/admin/users/:id/role`
- `GET /api/catalog`, `GET /api/search?q=`
- `POST /api/orders`, `POST /api/orders/:id/status`, `GET /api/orders?page=&limit=`
- `POST /api/payments`, `POST /api/transfers`
- `POST /api/coupons/validate`
- `GET /api/files?name=`
- `POST /api/integrations/preview`
- `POST /api/assistant`, `GET /api/assistant/history`
- `GET /api/reports/slow`, `GET /api/diagnostics/error`
- `GET /api/data/customers?q=`, `DELETE /api/data/customers/:id`

Browser screens are `/`, `/admin`, and `/assistant`.


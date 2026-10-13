# ledger-api

Internal money ledger used by the billing team. Accounts hold integer cent
balances; transfers move money between accounts of the same currency and
charge a fee; invoices compute subtotal, tax and total.

## Running

```
npm ci
npm run build
ADMIN_TOKEN=change-me PORT=3000 npm start
```

Environment:

| Variable         | Required | Default    | Notes                                  |
| ---------------- | -------- | ---------- | -------------------------------------- |
| `ADMIN_TOKEN`    | yes      |            | Bearer token for every route but /health |
| `PORT`           | no       | `3000`     |                                        |
| `HOST`           | no       | `0.0.0.0`  |                                        |
| `LEDGER_DB_PATH` | no       | `:memory:` | SQLite file path, e.g. `./data/ledger.db` |

The server refuses to start when `ADMIN_TOKEN` is missing.

## API

All routes except `GET /health` require `Authorization: Bearer <ADMIN_TOKEN>`.

- `GET /health`
- `POST /accounts` `{ "name": "Ops", "currency": "USD" }`
- `GET /accounts/:id`
- `GET /accounts/:id/entries`
- `POST /accounts/:id/deposits` `{ "amountCents": 10000, "reference": "wire 991" }`
- `POST /transfers` `{ "fromAccountId": 1, "toAccountId": 2, "amount": "25.00", "reference": "rent" }`
- `POST /invoices` `{ "accountId": 1, "taxRateBps": 825, "lines": [{ "description": "Seat", "quantity": 3, "unitPriceCents": 1999 }] }`
- `GET /invoices/:id`

### Money rules

- Amounts are stored as integer cents.
- Transfer amounts are decimal strings with at most two decimals.
- Transfer fee: 0.5 % of the amount, rounded half up to the cent, minimum 25 cents.
  The fee is debited from the sender on top of the amount.
- Invoice tax: subtotal times `taxRateBps / 10000`, rounded half up to the nearest cent.

Validation errors return HTTP 400, unknown resources 404, insufficient funds 422.

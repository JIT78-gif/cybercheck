# checkout-gateway

Express backend that creates Stripe PaymentIntents and sends receipts through
SendGrid. Postgres is used for the readiness check (and soon for order storage).

## Configuration

Copy `.env.example` and fill in real values. The server refuses to start when
any required variable is missing.

| Variable            | Required | Notes                                  |
| ------------------- | -------- | -------------------------------------- |
| `STRIPE_SECRET_KEY` | yes      | `sk_live_...` or `sk_test_...`         |
| `SENDGRID_API_KEY`  | yes      |                                        |
| `DATABASE_URL`      | yes      | `postgres://user:pass@host:5432/db`    |
| `INTERNAL_API_TOKEN`| yes      | bearer token for the POST endpoints    |
| `MAIL_FROM`         | no       | default `receipts@example.com`         |
| `PORT`              | no       | default `3000`                         |

## Endpoints

The POST endpoints require `Authorization: Bearer <INTERNAL_API_TOKEN>`.

- `GET /health` liveness, no dependencies
- `GET /ready` 200 when Postgres answers, 503 otherwise
- `POST /payments` `{ "amountCents": 1999, "currency": "usd", "customerEmail": "a@b.co" }`
  - 201 `{ id, status, clientSecret }`
  - 402 when Stripe declines, 502 when Stripe is unreachable or failing
- `POST /notifications/email` `{ "to": "a@b.co", "subject": "Receipt", "text": "Thanks" }`
  - 202 when SendGrid accepted it, 502 when SendGrid is unreachable or failing

## Tests

`npm test` runs unit tests with mocked HTTP plus `test/providers.contract.test.ts`,
which talks to the real Stripe and SendGrid APIs with an invalid key and expects
them to answer 401.

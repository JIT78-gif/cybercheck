# tripdesk

npm workspaces monorepo.

| Workspace        | Path            | What                                            |
| ---------------- | --------------- | ----------------------------------------------- |
| `@tripdesk/core` | `packages/core` | Date and pricing helpers shared by all apps     |
| `@tripdesk/api`  | `apps/api`      | Express HTTP API built on `@tripdesk/core`      |

```
npm ci
npm run build          # core first, then api
npm test               # runs every workspace's tests
PORT=3000 npm start    # starts apps/api (after build)
```

## API

- `GET /health`
- `GET /itinerary/days?start=2025-03-01&end=2025-03-03` every day of the trip, start and end included
- `POST /quotes` `{ "checkIn": "2025-03-01", "checkOut": "2025-03-04", "nightlyRateCents": 12000 }`

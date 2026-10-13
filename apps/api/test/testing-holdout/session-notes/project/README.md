# session-notes

Single-user notes dashboard API. One shared password, cookie session.

```
npm ci
npm run build
DASHBOARD_PASSWORD=choose-something PORT=3000 npm start
```

| Variable             | Required | Notes                                                      |
| -------------------- | -------- | ---------------------------------------------------------- |
| `DASHBOARD_PASSWORD` | yes      | the server refuses to start without it                     |
| `SESSION_SECRET`     | no       | 32+ chars; random per process when unset (sessions reset on restart) |
| `PORT`               | no       | default 3000                                               |

## Endpoints

- `GET /health` public
- `POST /login` `{ "password": "..." }` sets the `sid` cookie, 401 on a wrong password
- `POST /logout`
- `GET /api/notes?limit=20&offset=0`
- `POST /api/notes` `{ "title": "...", "body": "...", "pinned": false }`
- `GET /api/notes/:id`
- `PATCH /api/notes/:id` any subset of `title`, `body`, `pinned`
- `DELETE /api/notes/:id`

Every `/api/*` route answers 401 without a signed-in session.

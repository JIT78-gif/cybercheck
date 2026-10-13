# pg-tasks

Task tracking API on Express and PostgreSQL. Tables are created on startup.

```
npm ci
DATABASE_URL=postgresql://user:pass@localhost:5432/tasks npm start   # PORT defaults to 3000
DATABASE_URL=postgresql://user:pass@localhost:5432/tasks_test npm test
```

The server refuses to start without `DATABASE_URL`. The test suite needs a
reachable PostgreSQL in `DATABASE_URL` and truncates the tables it uses.

## Endpoints

- `GET /health` (also checks the database)
- `GET /tasks?page=1&pageSize=20&status=open` pages are 1-based; returns `{ items, page, pageSize, total }`
- `POST /tasks` `{ "title": "Write docs", "priority": 2 }` (priority 1..5, default 3)
- `GET /tasks/:id`
- `PATCH /tasks/:id` `{ "title"?, "priority"?, "status"?: "open" | "done" }`
- `DELETE /tasks/:id`

Items are ordered by id ascending.

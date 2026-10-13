# todo-express

A small in-memory todo list API.

```
npm ci
npm start          # listens on PORT, default 3000
npm test
```

## Endpoints

| Method | Path          | Body / query                                                                      |
| ------ | ------------- | --------------------------------------------------------------------------------- |
| GET    | /health       |                                                                                   |
| GET    | /todos        | `?done=true\|false&limit=1..100&offset=0..`                                       |
| POST   | /todos        | `{ "title": string(1..200), "notes"?: string(..2000), "priority"?: "low"\|"normal"\|"high", "dueDate"?: "YYYY-MM-DD" }` |
| GET    | /todos/:id    |                                                                                   |
| PATCH  | /todos/:id    | any subset of the create fields plus `"done": boolean`                            |
| DELETE | /todos/:id    |                                                                                   |

Titles are trimmed before validation and storage. Unknown fields are rejected
with 400. Malformed ids return 400, unknown ids 404.

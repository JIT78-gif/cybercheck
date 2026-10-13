# notes-service

Tiny notes API (Fastify + zod). Notes live in memory.

```
npm ci
npm run build
npm start            # PORT defaults to 3000
```

## Endpoints

- `GET /health`
- `GET /notes?tag=work` list notes, newest first, optional tag filter
- `POST /notes` `{ "title": "...", "body": "...", "tags": ["work"] }`
- `GET /notes/:id`
- `PUT /notes/:id` same body as POST
- `DELETE /notes/:id`

Ids are UUIDs. Validation errors return 400, unknown ids 404.

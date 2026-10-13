"use strict";

const request = require("supertest");
const { createApp } = require("../src/app");
const { randomTitle } = require("./fixtures");

let app;

beforeEach(() => {
  app = createApp();
});

describe("GET /health", () => {
  test("returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /todos", () => {
  test("creates a todo with defaults", async () => {
    const res = await request(app).post("/todos").send({ title: "Water the plants" });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/todos/${res.body.id}`);
    expect(res.body).toMatchObject({
      title: "Water the plants",
      notes: "",
      priority: "normal",
      dueDate: null,
      done: false,
    });
  });

  test("trims the title", async () => {
    const res = await request(app).post("/todos").send({ title: "   Pay invoice  " });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Pay invoice");
  });

  test("creates todos with generated titles", async () => {
    const title = randomTitle();
    const res = await request(app).post("/todos").send({ title });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe(title);
  });

  test("rejects a missing or blank title", async () => {
    expect((await request(app).post("/todos").send({})).status).toBe(400);
    expect((await request(app).post("/todos").send({ title: "   " })).status).toBe(400);
    expect((await request(app).post("/todos").send({ title: 42 })).status).toBe(400);
  });

  test("rejects unknown fields", async () => {
    const res = await request(app).post("/todos").send({ title: "Plan sprint", owner: "ana" });
    expect(res.status).toBe(400);
    expect(res.body.details).toContain("unknown field: owner");
  });

  test("rejects an impossible due date", async () => {
    const res = await request(app).post("/todos").send({ title: "Renew passport", dueDate: "2025-02-30" });
    expect(res.status).toBe(400);
  });

  test("rejects malformed JSON", async () => {
    const res = await request(app).post("/todos").set("Content-Type", "application/json").send('{"title": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_json" });
  });
});

describe("GET /todos/:id", () => {
  test("returns 404 for an unknown id and 400 for a malformed id", async () => {
    expect((await request(app).get("/todos/999")).status).toBe(404);
    expect((await request(app).get("/todos/abc")).status).toBe(400);
  });
});

describe("PATCH /todos/:id", () => {
  test("marks a todo as done", async () => {
    const created = await request(app).post("/todos").send({ title: "Clean garage" });
    const res = await request(app).patch(`/todos/${created.body.id}`).send({ done: true });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(true);
    expect(res.body.title).toBe("Clean garage");
  });

  test("rejects a non-boolean done flag", async () => {
    const created = await request(app).post("/todos").send({ title: "Clean garage" });
    const res = await request(app).patch(`/todos/${created.body.id}`).send({ done: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /todos/:id", () => {
  test("removes the todo", async () => {
    const created = await request(app).post("/todos").send({ title: "Email team" });
    expect((await request(app).delete(`/todos/${created.body.id}`)).status).toBe(204);
    expect((await request(app).get(`/todos/${created.body.id}`)).status).toBe(404);
    expect((await request(app).delete(`/todos/${created.body.id}`)).status).toBe(404);
  });
});

describe("GET /todos", () => {
  test("filters by done and paginates", async () => {
    for (const title of ["a", "b", "c", "d"]) {
      await request(app).post("/todos").send({ title });
    }
    await request(app).patch("/todos/2").send({ done: true });

    const open = await request(app).get("/todos?done=false&limit=2&offset=1");
    expect(open.status).toBe(200);
    expect(open.body.total).toBe(3);
    expect(open.body.items.map((t) => t.title)).toEqual(["c", "d"]);

    expect((await request(app).get("/todos?limit=0")).status).toBe(400);
  });
});

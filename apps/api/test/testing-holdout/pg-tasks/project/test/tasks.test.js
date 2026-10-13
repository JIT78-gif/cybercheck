"use strict";

const request = require("supertest");
const { createApp } = require("../src/app");
const { testPool, resetDatabase } = require("./db");

let pool;
let app;

beforeAll(() => {
  pool = testPool();
  app = createApp(pool);
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

async function createTasks(titles) {
  const created = [];
  for (const title of titles) {
    const res = await request(app).post("/tasks").send({ title });
    created.push(res.body);
  }
  return created;
}

describe("GET /health", () => {
  test("reports ok when the database answers", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /tasks", () => {
  test("creates a task with defaults", async () => {
    const res = await request(app).post("/tasks").send({ title: "  Write release notes " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, title: "Write release notes", priority: 3, status: "open" });
    expect(res.headers.location).toBe("/tasks/1");
  });

  test("rejects invalid input", async () => {
    expect((await request(app).post("/tasks").send({})).status).toBe(400);
    expect((await request(app).post("/tasks").send({ title: "x", priority: 9 })).status).toBe(400);
    expect((await request(app).post("/tasks").send({ title: "x", owner: "ana" })).status).toBe(400);
  });
});

describe("GET /tasks/:id", () => {
  test("returns a stored task", async () => {
    await createTasks(["Plan sprint"]);
    const res = await request(app).get("/tasks/1");
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Plan sprint");
  });

  test("returns 404 for unknown ids and 400 for malformed ids", async () => {
    expect((await request(app).get("/tasks/42")).status).toBe(404);
    expect((await request(app).get("/tasks/abc")).status).toBe(400);
  });
});

describe("PATCH /tasks/:id", () => {
  test("marks a task as done", async () => {
    await createTasks(["Fix login page"]);
    const res = await request(app).patch("/tasks/1").send({ status: "done", priority: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "done", priority: 1, title: "Fix login page" });
  });

  test("rejects an unknown status", async () => {
    await createTasks(["Fix login page"]);
    expect((await request(app).patch("/tasks/1").send({ status: "archived" })).status).toBe(400);
  });
});

describe("DELETE /tasks/:id", () => {
  test("removes the task", async () => {
    await createTasks(["Old task"]);
    expect((await request(app).delete("/tasks/1")).status).toBe(204);
    expect((await request(app).get("/tasks/1")).status).toBe(404);
  });
});

describe("GET /tasks", () => {
  test("reports the total number of matching tasks", async () => {
    await createTasks(["a", "b", "c"]);
    await request(app).patch("/tasks/2").send({ status: "done" });
    const res = await request(app).get("/tasks?status=open");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  test("returns the first page of tasks in id order", async () => {
    await createTasks(["one", "two", "three", "four", "five"]);
    const res = await request(app).get("/tasks?page=1&pageSize=2");
    expect(res.status).toBe(200);
    expect(res.body.items.map((t) => t.title)).toEqual(["one", "two"]);
    expect(res.body.total).toBe(5);
  });

  test("rejects an invalid page size", async () => {
    expect((await request(app).get("/tasks?pageSize=0")).status).toBe(400);
    expect((await request(app).get("/tasks?page=0")).status).toBe(400);
  });
});

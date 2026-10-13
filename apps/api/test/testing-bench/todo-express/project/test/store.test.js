"use strict";

const { TodoStore } = require("../src/store");

function fixedClock(iso) {
  let current = new Date(iso);
  const clock = () => current;
  clock.advance = (ms) => {
    current = new Date(current.getTime() + ms);
  };
  return clock;
}

describe("TodoStore", () => {
  test("assigns sequential ids", () => {
    const store = new TodoStore(fixedClock("2025-01-01T00:00:00Z"));
    expect(store.create({ title: "a" }).id).toBe(1);
    expect(store.create({ title: "b" }).id).toBe(2);
  });

  test("keeps createdAt and bumps updatedAt on update", () => {
    const clock = fixedClock("2025-01-01T00:00:00Z");
    const store = new TodoStore(clock);
    const todo = store.create({ title: "a" });
    clock.advance(60_000);
    const updated = store.update(todo.id, { done: true });
    expect(updated.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2025-01-01T00:01:00.000Z");
  });

  test("returns copies so callers cannot mutate stored items", () => {
    const store = new TodoStore(fixedClock("2025-01-01T00:00:00Z"));
    const todo = store.create({ title: "a" });
    todo.title = "changed";
    expect(store.get(todo.id).title).toBe("a");
  });
});

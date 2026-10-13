"use strict";

class TodoStore {
  constructor(clock = () => new Date()) {
    this.clock = clock;
    this.items = new Map();
    this.nextId = 1;
  }

  create(input) {
    const now = this.clock().toISOString();
    const todo = {
      id: this.nextId++,
      title: input.title,
      notes: input.notes ?? "",
      priority: input.priority ?? "normal",
      dueDate: input.dueDate ?? null,
      done: false,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(todo.id, todo);
    return { ...todo };
  }

  get(id) {
    const todo = this.items.get(id);
    return todo ? { ...todo } : undefined;
  }

  list({ done, limit, offset }) {
    const all = [...this.items.values()].filter((t) => done === undefined || t.done === done);
    return {
      total: all.length,
      items: all.slice(offset, offset + limit).map((t) => ({ ...t })),
    };
  }

  update(id, changes) {
    const todo = this.items.get(id);
    if (!todo) return undefined;
    const updated = { ...todo, ...changes, id: todo.id, createdAt: todo.createdAt, updatedAt: this.clock().toISOString() };
    this.items.set(id, updated);
    return { ...updated };
  }

  remove(id) {
    return this.items.delete(id);
  }
}

module.exports = { TodoStore };

import { describe, expect, it } from "vitest";
import { createOrder, transition } from "../src/orders/lifecycle.js";

const t0 = new Date("2025-03-01T10:00:00Z");
const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

describe("order lifecycle", () => {
  it("starts in created", () => {
    const order = createOrder("o1", "c1", 4999, t0);
    expect(order.status).toBe("created");
    expect(order.history).toEqual([]);
  });

  it("goes through payment, shipping and delivery", () => {
    let order = createOrder("o1", "c1", 4999, t0);
    order = transition(order, "paid", later(1), "card ok");
    order = transition(order, "shipped", later(60));
    order = transition(order, "delivered", later(2 * 24 * 60));

    expect(order.status).toBe("delivered");
    expect(order.history.map((h) => `${h.from}->${h.to}`)).toEqual([
      "created->paid",
      "paid->shipped",
      "shipped->delivered",
    ]);
    expect(order.history[0]?.note).toBe("card ok");
    expect(order.updatedAt).toBe("2025-03-03T10:00:00.000Z");
  });

  it("can be cancelled before payment", () => {
    const order = transition(createOrder("o1", "c1", 4999, t0), "cancelled", later(5));
    expect(order.status).toBe("cancelled");
  });

  it("does not mutate the original order", () => {
    const original = createOrder("o1", "c1", 4999, t0);
    transition(original, "paid", later(1));
    expect(original.status).toBe("created");
  });
});

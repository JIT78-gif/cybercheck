import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("orders API", () => {
  it("reports health", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("creates an order and walks it to delivered", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { customerId: "c_123", totalCents: 4999 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    for (const to of ["paid", "shipped", "delivered"]) {
      const res = await app.inject({ method: "POST", url: `/orders/${id}/transitions`, payload: { to } });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(to);
    }

    const fetched = await app.inject({ method: "GET", url: `/orders/${id}` });
    expect(fetched.json().history).toHaveLength(3);

    const delivered = await app.inject({ method: "GET", url: "/orders?status=delivered" });
    expect(delivered.json().orders).toHaveLength(1);
  });
});

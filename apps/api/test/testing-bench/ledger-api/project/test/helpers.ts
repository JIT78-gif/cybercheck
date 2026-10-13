import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

export const TEST_TOKEN = "test-admin-token-123";
export const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

export function makeApp(): FastifyInstance {
  return buildApp({ adminToken: TEST_TOKEN, dbPath: ":memory:" });
}

export async function createAccount(app: FastifyInstance, name: string, currency = "USD"): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/accounts",
    headers: authHeaders,
    payload: { name, currency },
  });
  if (res.statusCode !== 201) {
    throw new Error(`createAccount failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().id as number;
}

export async function depositCents(app: FastifyInstance, accountId: number, amountCents: number): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/accounts/${accountId}/deposits`,
    headers: authHeaders,
    payload: { amountCents },
  });
  if (res.statusCode !== 201) {
    throw new Error(`deposit failed: ${res.statusCode} ${res.body}`);
  }
}

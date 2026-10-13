import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { createAccount, deposit, getAccountOrThrow, listEntries } from "../repository.js";

const CreateAccountBody = z.object({
  name: z.string().trim().min(1).max(120),
  currency: z.enum(["USD", "EUR", "BRL"]),
});

const AccountParams = z.object({
  id: z.coerce.number().int().positive(),
});

const DepositBody = z.object({
  amountCents: z.number().int().positive().max(100_000_000),
  reference: z.string().trim().max(140).optional(),
});

export const accountRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post("/accounts", async (request, reply) => {
    const body = CreateAccountBody.parse(request.body);
    const account = createAccount(db, body.name, body.currency);
    return reply.code(201).send(account);
  });

  app.get("/accounts/:id", async (request) => {
    const { id } = AccountParams.parse(request.params);
    return getAccountOrThrow(db, id);
  });

  app.get("/accounts/:id/entries", async (request) => {
    const { id } = AccountParams.parse(request.params);
    return { entries: listEntries(db, id) };
  });

  app.post("/accounts/:id/deposits", async (request, reply) => {
    const { id } = AccountParams.parse(request.params);
    const body = DepositBody.parse(request.body);
    const account = deposit(db, id, body.amountCents, body.reference ?? null);
    return reply.code(201).send(account);
  });
};

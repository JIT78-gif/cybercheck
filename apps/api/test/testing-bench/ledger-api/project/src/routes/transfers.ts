import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../db.js";
import { ValidationError } from "../errors.js";
import { parseAmount, transferFee } from "../money.js";
import { executeTransfer } from "../repository.js";

interface TransferBody {
  fromAccountId: number;
  toAccountId: number;
  amount: string;
  reference?: string;
}

export const transferRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post("/transfers", async (request, reply) => {
    const body = request.body as TransferBody;
    const amountCents = parseAmount(body.amount);
    if (amountCents <= 0) {
      throw new ValidationError("amount must be greater than zero");
    }
    if (body.fromAccountId === body.toAccountId) {
      throw new ValidationError("cannot transfer to the same account");
    }

    const result = executeTransfer(db, {
      fromAccountId: body.fromAccountId,
      toAccountId: body.toAccountId,
      amountCents,
      feeCents: transferFee(amountCents),
      reference: body.reference ?? null,
    });
    return reply.code(201).send(result);
  });
};

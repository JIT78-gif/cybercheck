import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { NotFoundError } from "../errors.js";
import { computeInvoiceTotals } from "../money.js";
import { createInvoice, getInvoice } from "../repository.js";

const InvoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().int().positive().max(10_000),
  unitPriceCents: z.number().int().nonnegative().max(10_000_000),
});

const CreateInvoiceBody = z.object({
  accountId: z.number().int().positive(),
  taxRateBps: z.number().int().min(0).max(5_000),
  lines: z.array(InvoiceLineSchema).min(1).max(100),
});

const InvoiceParams = z.object({
  id: z.coerce.number().int().positive(),
});

export const invoiceRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.post("/invoices", async (request, reply) => {
    const body = CreateInvoiceBody.parse(request.body);
    const totals = computeInvoiceTotals(body.lines, body.taxRateBps);
    const invoice = createInvoice(db, body.accountId, body.taxRateBps, body.lines, totals);
    return reply.code(201).send(invoice);
  });

  app.get("/invoices/:id", async (request) => {
    const { id } = InvoiceParams.parse(request.params);
    const invoice = getInvoice(db, id);
    if (!invoice) {
      throw new NotFoundError(`Invoice ${id} not found`);
    }
    return invoice;
  });
};

import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { createOrder, InvalidTransitionError, ORDER_STATUSES, transition } from "./orders/lifecycle.js";
import { OrderRepository } from "./orders/repository.js";

const CreateOrderBody = z.object({
  customerId: z.string().trim().min(1).max(64),
  totalCents: z.number().int().positive().max(100_000_000),
});

const TransitionBody = z.object({
  to: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(500).optional(),
});

const OrderParams = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ status: z.enum(ORDER_STATUSES).optional() });

export interface AppDeps {
  repository?: OrderRepository;
  clock?: () => Date;
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const repository = deps.repository ?? new OrderRepository();
  const clock = deps.clock ?? (() => new Date());
  const app = Fastify({ logger: false });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_failed", issues: error.issues });
    }
    if (error instanceof InvalidTransitionError) {
      return reply.code(409).send({ error: "invalid_transition", from: error.from, to: error.to });
    }
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "bad_request", message: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/orders", async (request, reply) => {
    const body = CreateOrderBody.parse(request.body);
    const order = createOrder(randomUUID(), body.customerId, body.totalCents, clock());
    return reply.code(201).send(repository.save(order));
  });

  app.get("/orders", async (request) => {
    const { status } = ListQuery.parse(request.query);
    return { orders: repository.list(status) };
  });

  app.get("/orders/:id", async (request, reply) => {
    const { id } = OrderParams.parse(request.params);
    const order = repository.find(id);
    if (!order) return reply.code(404).send({ error: "not_found" });
    return order;
  });

  app.post("/orders/:id/transitions", async (request, reply) => {
    const { id } = OrderParams.parse(request.params);
    const body = TransitionBody.parse(request.body);
    const order = repository.find(id);
    if (!order) return reply.code(404).send({ error: "not_found" });
    const updated = transition(order, body.to, clock(), body.note);
    return repository.save(updated);
  });

  return app;
}

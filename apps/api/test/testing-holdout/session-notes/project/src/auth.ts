import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface Session {
    authenticated?: boolean;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function passwordMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  return timingSafeEqual(digest(given), digest(expected));
}

export async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  if (request.session.get("authenticated") !== true) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export function bearerAuth(expectedToken: string) {
  const expected = Buffer.from(expectedToken);

  return async function verifyBearer(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const given = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}

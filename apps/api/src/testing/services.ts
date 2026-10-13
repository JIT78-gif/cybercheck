import type { ProjectDossier } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";

/**
 * Local throwaway services some projects need to start or test (PostgreSQL, Redis), installed while
 * the network is on (prepare) and started inside each sandbox that needs them, on 127.0.0.1 only.
 *
 * PostgreSQL: the sandbox VM has no System V shared memory, so a real server cannot start. PGlite
 * (PostgreSQL compiled to WebAssembly) serves the same wire protocol instead; the report says so.
 */

export type Service = "postgres" | "redis";

export const SERVICE_ENV: Record<Service, Record<string, string>> = {
  postgres: {
    DATABASE_URL: "postgresql://postgres:cc-test-password@127.0.0.1:5432/postgres",
    POSTGRES_URL: "postgresql://postgres:cc-test-password@127.0.0.1:5432/postgres",
    PGHOST: "127.0.0.1",
    PGPORT: "5432",
    PGUSER: "postgres",
    PGPASSWORD: "cc-test-password",
    PGDATABASE: "postgres",
  },
  redis: { REDIS_URL: "redis://127.0.0.1:6379", REDIS_HOST: "127.0.0.1", REDIS_PORT: "6379" },
};

export const SERVICE_NOTES: Record<Service, string> = {
  postgres: "PostgreSQL is provided by PGlite (PostgreSQL compiled to WebAssembly) because the sandbox cannot run a full server; extensions and some server features may differ.",
  redis: "Redis is a local redis-server started inside the sandbox.",
};

/** Services the project evidently uses (dependencies, compose images, integrations), not guesses. */
export function detectServices(d: ProjectDossier, src: SnapshotSource): Service[] {
  const out = new Set<Service>();
  const deps = new Set(d.dependencies.map((x) => x.name.toLowerCase()));
  const names = d.integrations.map((i) => i.name.toLowerCase()).join(" ");
  const prismaPg = [...src.files.values()].some((f) => f.path.endsWith("schema.prisma") && /provider\s*=\s*"postgres(ql)?"/.test(f.text));
  if (["pg", "postgres", "pg-promise", "psycopg2", "psycopg2-binary", "psycopg", "asyncpg", "@neondatabase/serverless"].some((x) => deps.has(x)) || prismaPg || /postgres/.test(names)) out.add("postgres");
  if (["redis", "ioredis", "bullmq", "bull", "redis-py"].some((x) => deps.has(x)) || /redis/.test(names)) out.add("redis");
  return [...out];
}

const PG = "/opt/cc-pg";

/** Install command (network on). Empty when nothing is needed. */
export function installServices(services: Service[]) {
  const steps: string[] = [];
  if (services.includes("postgres")) steps.push(`mkdir -p ${PG} && cd ${PG} && echo '{"private":true}' > package.json && npm install @electric-sql/pglite@0.5.8 @electric-sql/pglite-socket@0.2.11 --no-audit --no-fund >/dev/null`);
  if (services.includes("redis")) steps.push("export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq --no-install-recommends redis-server >/dev/null");
  return steps.length ? `${steps.join(" && ")} && echo services installed` : "";
}

const waitPort = (port: number) =>
  `for i in $(seq 1 60); do node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" && break; sleep 0.5; done`;
const portOpen = (port: number) => `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;

/** Shell prelude that starts the services (network off). Each prints a clear ready or failed marker. */
export function startServices(services: Service[]) {
  const parts: string[] = [];
  if (services.includes("postgres")) {
    parts.push(
      `(nohup ${PG}/node_modules/.bin/pglite-server --db=/tmp/cc-pgdata --host=127.0.0.1 --port=5432 --max-connections=32 >/tmp/cc-postgres.log 2>&1 &)`,
      waitPort(5432),
      `(${portOpen(5432)} && echo "cybercheck: local PostgreSQL (PGlite) is ready" || echo "cybercheck: local PostgreSQL did not start, so code that needs a database will fail" >&2)`,
    );
  }
  if (services.includes("redis")) {
    parts.push(
      "(redis-server --daemonize yes --bind 127.0.0.1 >/dev/null 2>&1 || true)",
      waitPort(6379),
      `(${portOpen(6379)} && echo "cybercheck: local Redis is ready" || echo "cybercheck: local Redis did not start" >&2)`,
    );
  }
  return parts.length ? `${parts.join("; ")}; ` : "";
}

export function serviceEnv(services: Service[]) {
  return Object.assign({}, ...services.map((s) => SERVICE_ENV[s])) as Record<string, string>;
}

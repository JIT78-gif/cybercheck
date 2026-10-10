import { buildApp } from "./app.ts";
import { pool } from "./db/client.ts";
import { env, providers } from "./env.ts";
import { recoverInterruptedSnapshots } from "./intake/pipeline.ts";
import { recoverUnderstanding } from "./understanding/run.ts";

const app = await buildApp();

// Shut down cleanly so a restart (e.g. after editing .env) can take over the port.
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

/** The previous process may still be releasing the port during a restart: wait instead of crashing. */
async function listenWithRetry(attempts = 20, delayMs = 250) {
  for (let i = 1; ; i++) {
    try {
      await app.listen({ port: env.API_PORT, host: "127.0.0.1" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

try {
  const recovered = await recoverInterruptedSnapshots();
  if (recovered > 0) console.log(`[intake] marked ${recovered} interrupted snapshot(s) as failed`);
  await listenWithRetry();
  const requeued = await recoverUnderstanding();
  if (requeued > 0) console.log(`[understanding] re-queued ${requeued} analysis run(s)`);
  console.log(
    `cybercheck API on http://127.0.0.1:${env.API_PORT}  ` +
      `(google: ${providers.google ? "on" : "off"}, github: ${providers.github ? "on" : "off"}, ` +
      `github app: ${providers.githubApp ? "on" : "off"}, email: ${providers.smtp ? "smtp" : "console"})`,
  );
} catch (err) {
  app.log.error(err);
  console.error(
    (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `Port ${env.API_PORT} is still in use by another process. Stop it, or set API_PORT in .env.`
      : "The API failed to start.",
  );
  process.exit(1);
}

import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

try {
  const address = await app.listen({ port, host });
  console.log(`order-workflow listening on ${address}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

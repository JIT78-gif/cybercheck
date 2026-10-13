import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

app
  .listen({ port, host })
  .then((address) => {
    console.log(`notes-service listening on ${address}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

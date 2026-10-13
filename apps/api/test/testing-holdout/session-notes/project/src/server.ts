import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[session-notes] ${(err as Error).message}`);
  process.exit(1);
}

const app = buildApp(config);

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

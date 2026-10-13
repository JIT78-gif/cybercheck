import { createApp } from "./app.js";
import { createSendgridMailer } from "./clients/sendgrid.js";
import { createStripeClient } from "./clients/stripe.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[checkout-gateway] ${(err as Error).message}`);
  process.exit(1);
}

const db = createDatabase(config.databaseUrl);
const app = createApp({
  stripe: createStripeClient({ secretKey: config.stripeSecretKey }),
  mailer: createSendgridMailer({ apiKey: config.sendgridApiKey, from: config.mailFrom }),
  db,
  internalApiToken: config.internalApiToken,
});

const server = app.listen(config.port, () => {
  console.log(`[checkout-gateway] listening on port ${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void db.close().finally(() => process.exit(0));
    });
  });
}

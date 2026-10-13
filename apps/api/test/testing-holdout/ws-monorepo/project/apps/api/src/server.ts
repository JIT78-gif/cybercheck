import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

const server = createApp().listen(port, () => {
  console.log(`[tripdesk-api] listening on port ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

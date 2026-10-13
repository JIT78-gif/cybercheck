"use strict";

const { createApp } = require("./app");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

const server = createApp().listen(port, host, () => {
  console.log(`todo-express listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

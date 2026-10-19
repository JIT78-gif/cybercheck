const { app } = require("./app");

const port = Number(process.env.PORT ?? 4320);
const host = process.env.HOST ?? "127.0.0.1";

app.listen(port, host, () => {
  console.log(`Agent Mart clean control listening on http://${host}:${port}`);
  console.log("Clean control fixture.");
});

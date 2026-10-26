if (process.env.NODE_ENV === "production") {
  throw new Error("cybercheck-mini-gauntlet is deliberately vulnerable and refuses to run in production mode");
}

const app = require("./app");
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? "127.0.0.1";

app.listen(port, host, () => {
  console.log(`Cybercheck mini gauntlet listening on http://${host}:${port}`);
  console.log("WARNING: intentionally vulnerable synthetic benchmark; never expose it to a network.");
});

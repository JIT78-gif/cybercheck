if (process.env.NODE_ENV === "production") {
  throw new Error("This intentionally flawed demo refuses to run in production mode.");
}

const app = require("./app");
const port = Number(process.env.PORT ?? 4320);
const host = "127.0.0.1";

app.listen(port, host, () => {
  console.log(`Hackathon demo store listening on http://${host}:${port}`);
  console.log("WARNING: intentionally flawed synthetic demo; never expose it to a network.");
});

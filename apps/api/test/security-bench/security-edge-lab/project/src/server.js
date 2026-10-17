const { app } = require("./app");

const port = Number(process.env.PORT ?? 4327);
const host = process.env.HOST ?? "127.0.0.1";

app.listen(port, host, () => {
  console.log(`Security Edge Lab listening on http://${host}:${port}`);
  console.log("WARNING: deliberately vulnerable benchmark; never expose it to a network.");
});

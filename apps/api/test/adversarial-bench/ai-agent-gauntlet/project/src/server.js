const { app } = require("./app");

const port = Number(process.env.PORT ?? 4319);
const host = process.env.HOST ?? "127.0.0.1";

app.listen(port, host, () => {
  console.log(`Agent Mart training fixture listening on http://${host}:${port}`);
  console.log("WARNING: deliberately vulnerable AI adversarial benchmark; never expose it to a network.");
});

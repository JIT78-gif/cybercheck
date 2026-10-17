const http = require("node:http");

// A loopback stand-in for an OpenAI-compatible chat completions API. Each test sets `reply` to a function that
// receives the request body and returns { status?, body } (or a message object for a normal completion).
function startFakeModel() {
  const state = { reply: () => ({ content: "ok" }), requests: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      state.requests.push(body);
      const out = state.reply(body, state.requests.length);
      if (out.status) {
        res.writeHead(out.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(out.body ?? {}));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...out } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ state, server, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const toolCall = (name, args, id = "call_1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

module.exports = { startFakeModel, toolCall };

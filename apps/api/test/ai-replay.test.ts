import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM harness library (runs inside the sandbox)
import { client, REPLAY_DEFAULT, startReplay } from "../src/testing/harness/lib.mjs";

// AI Evaluator Step D: the harness's loopback replay model. It speaks the OpenAI chat-completions shape, serves a
// script turn by turn (the last turn repeats), records every call, and can fail, send garbage or never answer.

type Replay = Awaited<ReturnType<typeof startReplay>>;
let replay: Replay | null = null;
afterEach(() => {
  replay?.close();
  replay = null;
});

const call = async (r: Replay, body: Record<string, unknown> = { model: "m", messages: [{ role: "user", content: "hi" }] }, timeoutMs = 3000) => {
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cc" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
};

describe("replay model", () => {
  it("serves the default answer when no script is armed, in the OpenAI shape, with usage", async () => {
    replay = await startReplay(0);
    const r = await call(replay);
    expect(r.status).toBe(200);
    const b = JSON.parse(r.text);
    expect(b.choices[0].message).toEqual({ role: "assistant", content: REPLAY_DEFAULT });
    expect(b.choices[0].finish_reason).toBe("stop");
    expect(b.usage.prompt_tokens).toBeGreaterThan(0);
    expect(replay.since(0)).toEqual([expect.objectContaining({ path: "/v1/chat/completions", served: "default" })]);
  });

  it("serves a script turn by turn and repeats the last turn", async () => {
    replay = await startReplay(0);
    replay.setScript([{ status: 500 }, { content: "Recovered." }]);
    expect((await call(replay)).status).toBe(500);
    expect(JSON.parse((await call(replay)).text).choices[0].message.content).toBe("Recovered.");
    expect(JSON.parse((await call(replay)).text).choices[0].message.content).toBe("Recovered.");
    expect(replay.since(0).map((x: { served: string }) => x.served)).toEqual(["status 500", "content", "content"]);
    // Arming a new script starts it from the top.
    replay.setScript([{ status: 503 }]);
    expect((await call(replay)).status).toBe(503);
  });

  it("returns tool calls, malformed bodies and streams", async () => {
    replay = await startReplay(0);
    replay.setScript([{ toolCalls: [{ name: "get_order_status", arguments: { orderId: "A-1001" } }] }]);
    const t = JSON.parse((await call(replay)).text).choices[0];
    expect(t.finish_reason).toBe("tool_calls");
    expect(t.message.tool_calls[0].function).toEqual({ name: "get_order_status", arguments: '{"orderId":"A-1001"}' });
    replay.setScript([{ malformed: true }]);
    expect(JSON.parse((await call(replay)).text).choices).toBeUndefined();
    replay.setScript([{ content: "Streamed answer." }]);
    const s = await call(replay, { model: "m", stream: true, messages: [] });
    expect(s.text).toContain('"content":"Streamed answer."');
    expect(s.text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("never answers a hanging turn until released, so the app's own timeout is what is tested", async () => {
    replay = await startReplay(0);
    replay.setScript([{ hang: true }]);
    const started = Date.now();
    const pending = call(replay, undefined, 400).catch((e: Error) => e.name);
    expect(await pending).toBe("TimeoutError");
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    replay.release();
    expect(replay.since(0)[0].served).toBe("hang");
  });

  it("refuses anything but chat completions, and the harness client honours a per-step timeout", async () => {
    replay = await startReplay(0);
    const res = await fetch(`http://127.0.0.1:${replay.port}/v1/embeddings`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    replay.setScript([{ hang: true }]);
    const request = client(`http://127.0.0.1:${replay.port}`);
    const r = await request({ method: "POST", path: "/v1/chat/completions", json: { messages: [] }, timeoutMs: 300 }, null);
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/Timeout|Abort/);
  });
});

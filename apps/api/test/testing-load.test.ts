import { describe, expect, it } from "vitest";
// @ts-expect-error: plain JavaScript that runs inside the sandbox
import { breakpointOf, loadSeries } from "../src/testing/harness/lib.mjs";
import { breakpointText } from "../src/testing/load.ts";
import { effectivePolicy } from "../src/testing/runtime.ts";

const HEADER = "metric_name,timestamp,metric_value,check,error,error_code,expected_response,group,method,name,proto,scenario,service,status,subproto,tls_version,url,extra_tags,metadata";
const row = (metric: string, ts: number, value: number) => `${metric},${ts},${value},,,,true,,GET,/api/items,HTTP/1.1,main,,200,,,"http://127.0.0.1:3000/api/items?a=1,b=2",,`;
type Point = { t: number; rps: number; p50Ms: number | null; p95Ms: number | null; errorRatePct: number; vus: number | null };
const pt = (t: number, rps: number, p95Ms: number, errorRatePct = 0): Point => ({ t, rps, p50Ms: p95Ms / 2, p95Ms, errorRatePct, vus: null });

describe("load series from k6 CSV", () => {
  it("buckets requests per second with latency percentiles, failures and virtual users", () => {
    const s = loadSeries();
    s.line(HEADER);
    for (let i = 1; i <= 10; i++) s.line(row("http_req_duration", 1000, i * 10));
    s.line(row("http_req_failed", 1000, 1));
    for (let i = 0; i < 9; i++) s.line(row("http_req_failed", 1000, 0));
    s.line(row("vus", 1000, 7));
    s.line(row("http_reqs", 1000, 1)); // other metrics are ignored
    s.line(row("http_req_duration", 1001, 5));
    s.line(row("http_req_failed", 1001, 0));
    expect(s.points()).toEqual([
      { t: 0, rps: 10, p50Ms: 50, p95Ms: 100, errorRatePct: 10, vus: 7 },
      { t: 1, rps: 1, p50Ms: 5, p95Ms: 5, errorRatePct: 0, vus: null },
    ]);
  });

  it("merges seconds so a long stage keeps at most the point limit", () => {
    const s = loadSeries(5);
    s.line(HEADER);
    for (let sec = 0; sec < 20; sec++) for (let i = 0; i < 4; i++) s.line(row("http_req_duration", 5000 + sec, 10));
    const pts = s.points();
    expect(pts).toHaveLength(5);
    expect(pts[0]).toMatchObject({ t: 0, rps: 4 });
    expect(pts.at(-1)!.t).toBe(16);
  });

  it("is empty without data, and ignores malformed lines", () => {
    const s = loadSeries();
    s.line(HEADER);
    s.line("garbage");
    s.line("http_req_duration,not-a-time,5");
    expect(s.points()).toEqual([]);
  });
});

describe("breakpoint", () => {
  it("is the highest healthy rate before errors stay above 5%", () => {
    const pts = [pt(0, 10, 20), pt(1, 50, 30), pt(2, 120, 80), pt(3, 180, 300), pt(4, 150, 900, 12), pt(5, 140, 1500, 30)];
    expect(breakpointOf(pts)).toEqual({ limitRps: 180, brokeBy: "errors" });
  });

  it("ignores one bad second, and reports slow answers as latency", () => {
    const pts = [pt(0, 10, 20), pt(1, 60, 2500), pt(2, 90, 40), pt(3, 130, 60), pt(4, 140, 2600), pt(5, 135, 3100)];
    expect(breakpointOf(pts)).toEqual({ limitRps: 130, brokeBy: "latency" });
  });

  it("says when the app crashed, when the generator ran out first, and when nothing gave way", () => {
    const healthy = [pt(0, 10, 20), pt(1, 200, 40), pt(2, 400, 60)];
    expect(breakpointOf(healthy, { appExited: true })).toEqual({ limitRps: 400, brokeBy: "crash" });
    expect(breakpointOf(healthy, { droppedIterations: 120 })).toEqual({ limitRps: 400, brokeBy: "generator" });
    expect(breakpointOf(healthy)).toEqual({ limitRps: 400, brokeBy: null });
    expect(breakpointOf([pt(0, 5, 3000, 50), pt(1, 5, 3000, 60)])).toEqual({ limitRps: null, brokeBy: "errors" });
  });

  it("puts the result in plain words", () => {
    expect(breakpointText({ limitRps: 180.4, brokeBy: "errors", series: [] })).toBe("Handled up to about 180 requests per second; above that, more than 5% of requests failed.");
    expect(breakpointText({ limitRps: 130, brokeBy: "latency", series: [] })).toMatch(/slowest 5% of answers took over 2 s/);
    expect(breakpointText({ limitRps: 90, brokeBy: "crash", series: [] })).toBe("The app process stopped after handling up to about 90 requests per second.");
    expect(breakpointText({ limitRps: null, brokeBy: null, series: [pt(0, 395, 20)] })).toBe("Handled the whole ramp, up to 395 requests per second, without giving way.");
  });
});

describe("load stages of a run", () => {
  it("follow the profile, the load switch and the user's own stage list", () => {
    expect(effectivePolicy({ profile: "fast" }, 1).loadStages).toEqual([]);
    expect(effectivePolicy({ profile: "standard" }, 1).loadStages).toEqual(["smoke"]);
    expect(effectivePolicy({ profile: "standard", load: true }, 1).loadStages).toEqual(["smoke", "average", "stress"]);
    expect(effectivePolicy({ profile: "deep" }, 1).loadStages).toEqual(["smoke", "average", "stress", "spike", "breakpoint"]);
    // The user's list wins, keeps the running order, and always starts with the smoke test.
    expect(effectivePolicy({ profile: "standard", load: true, loadStages: ["breakpoint", "spike"] }, 1).loadStages).toEqual(["smoke", "spike", "breakpoint"]);
    // Load switched off: only the smoke test, whatever stages were listed.
    expect(effectivePolicy({ profile: "deep", load: false, loadStages: ["breakpoint"] }, 1).loadStages).toEqual(["smoke"]);
  });
});

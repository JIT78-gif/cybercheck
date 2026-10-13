import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { TaskQueue } from "../src/taskQueue.js";

describe("TaskQueue", () => {
  it("resolves each task with its result", async () => {
    const queue = new TaskQueue({ concurrency: 2 });
    const results = await Promise.all([queue.add(() => 1), queue.add(async () => 2), queue.add(() => "three")]);
    expect(results).toEqual([1, 2, "three"]);
  });

  it("never runs more tasks than the concurrency limit", async () => {
    const queue = new TaskQueue({ concurrency: 3 });
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
    };
    await Promise.all(Array.from({ length: 10 }, () => queue.add(task)));
    expect(peak).toBe(3);
  });

  it("starts tasks in FIFO order with concurrency 1", async () => {
    const queue = new TaskQueue();
    const order: number[] = [];
    await Promise.all([3, 1, 2].map((n) => queue.add(async () => void order.push(n))));
    expect(order).toEqual([3, 1, 2]);
  });

  it("rejects the failing task and keeps processing the rest", async () => {
    const queue = new TaskQueue();
    const failing = queue.add(async () => {
      throw new Error("boom");
    });
    const ok = queue.add(() => "fine");
    await expect(failing).rejects.toThrow("boom");
    await expect(ok).resolves.toBe("fine");
  });

  it("holds tasks while paused", async () => {
    const queue = new TaskQueue();
    queue.pause();
    let ran = false;
    const done = queue.add(() => {
      ran = true;
    });
    await sleep(10);
    expect(ran).toBe(false);
    expect(queue.size).toBe(1);
    queue.resume();
    await done;
    expect(ran).toBe(true);
  });

  it("onDrain resolves once every task has finished", async () => {
    const queue = new TaskQueue({ concurrency: 2 });
    let finished = 0;
    for (let i = 0; i < 5; i++) {
      void queue.add(async () => {
        await sleep(2);
        finished++;
      });
    }
    await queue.onDrain();
    expect(finished).toBe(5);
    expect(queue.isIdle()).toBe(true);
  });

  it("notifies listeners when a resumed queue has finished", async () => {
    const queue = new TaskQueue({ concurrency: 2 });
    queue.pause();
    const seen: number[] = [];
    for (const n of [1, 2, 3]) {
      void queue.add(async () => {
        seen.push(n);
      });
    }

    const finished = once(queue, "idle");
    queue.resume();
    await finished;

    expect(seen).toEqual([1, 2, 3]);
  });

  it("rejects an invalid concurrency", () => {
    expect(() => new TaskQueue({ concurrency: 0 })).toThrow(RangeError);
    expect(() => new TaskQueue({ concurrency: 1.5 })).toThrow(RangeError);
  });
});

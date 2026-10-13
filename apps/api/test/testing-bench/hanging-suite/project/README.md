# @acme/task-queue

Promise based task queue with bounded concurrency, pause/resume and a retry helper.

```ts
import { TaskQueue, withRetry } from "@acme/task-queue";

const queue = new TaskQueue({ concurrency: 4 });
const result = await queue.add(() => fetchSomething());

queue.on("drain", () => console.log("all tasks finished"));
await queue.onDrain();

await withRetry(() => callUpstream(), { retries: 3, delayMs: 200 });
```

Events:

- `drain`: emitted every time the queue becomes idle (nothing running, nothing pending).

Scripts: `npm run build`, `npm run typecheck`, `npm test`.

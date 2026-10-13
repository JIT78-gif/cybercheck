import { EventEmitter, once } from "node:events";

export type Task<T> = () => Promise<T> | T;

export interface TaskQueueOptions {
  concurrency?: number;
}

export class TaskQueue extends EventEmitter {
  private readonly concurrency: number;
  private readonly pending: Array<() => void> = [];
  private running = 0;
  private paused = false;

  constructor(options: TaskQueueOptions = {}) {
    super();
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
    }
    this.concurrency = concurrency;
  }

  get size(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  add<T>(task: Task<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(() => {
        this.running++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.next();
          });
      });
      this.next();
    });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.next();
  }

  isIdle(): boolean {
    return this.running === 0 && this.pending.length === 0;
  }

  async onDrain(): Promise<void> {
    if (this.isIdle()) return;
    await once(this, "drain");
  }

  private next(): void {
    while (!this.paused && this.running < this.concurrency && this.pending.length > 0) {
      const start = this.pending.shift();
      start?.();
    }
    if (this.isIdle()) {
      this.emit("drain");
    }
  }
}

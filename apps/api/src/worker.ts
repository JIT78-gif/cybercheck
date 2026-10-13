// Testing worker entry point (separate process from the API): npm run worker
import { startWorker } from "./testing/worker.ts";

void startWorker();

import { createWorkerApp } from "./worker/app.js";

const workerApp = createWorkerApp();

process.once("SIGINT", () => {
  void workerApp.shutdown();
});
process.once("SIGTERM", () => {
  void workerApp.shutdown();
});

workerApp.bootstrap().catch((error) => {
  workerApp.logger.error(`startup failed: ${String(error)}`);
  process.exitCode = 1;
});

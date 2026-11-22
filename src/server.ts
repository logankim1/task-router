import { createApp } from "./app";
import { systemClock } from "./lib/clock";
import { openDb } from "./lib/db";
import { createRouterWorker } from "./lib/router-worker";
import {
  seedInitialTasks,
  sweepInterruptedAttemptsOnStartup,
} from "./lib/state-machine";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH;

const db = openDb(DB_PATH, systemClock, {
  onSeed: (database, clock) => seedInitialTasks(database, clock.nowMs()),
});

const sweptCount = sweepInterruptedAttemptsOnStartup(db, systemClock);
if (sweptCount > 0) {
  console.log(`[startup] Swept ${sweptCount} pending routing attempt(s) into interrupted_by_restart`);
}

const worker = createRouterWorker({
  db,
  clock: systemClock,
  seed: Number(process.env.ROUTER_SEED || 20260401),
});

const app = createApp({ db, worker, clock: systemClock });

const server = app.listen(PORT, () => {
  console.log(`[server] Task routing operator listening on http://localhost:${PORT}`);
});

function shutdown(signal: string) {
  console.log(`[server] Received ${signal}, shutting down...`);
  worker.stopAll();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
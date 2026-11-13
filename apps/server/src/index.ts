import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";

const config = readConfig();
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
const { app, agent } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) {
    // Second signal: the first shutdown is stuck; force an exit now.
    process.exit(1);
  }
  shuttingDown = true;
  const force = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  server.close(() => {
    void agent
      .stop()
      .then(() => db.close())
      .then(() => {
        clearTimeout(force);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

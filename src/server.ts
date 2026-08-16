import { createApp } from "./app.js";
import { loadConfigForRuntime } from "./config.js";
import { closeDatabase, openDatabase } from "./db/index.js";
import { allMigrations } from "./db/migrations/all.js";
import { runMigrations } from "./db/migrations/index.js";
import { applyDatabaseFallbackConfig } from "./runtime-config.js";

const db = openDatabase();
runMigrations(db, allMigrations);
const { config: loadedConfig, sourcePresence } = loadConfigForRuntime();
const config = applyDatabaseFallbackConfig(loadedConfig, sourcePresence, process.env);
const app = createApp({ config });

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

for (const signal of shutdownSignals) {
  process.once(signal, () => {
    void app.close().finally(() => {
      closeDatabase();
      process.exit(0);
    });
  });
}

try {
  await app.listen({
    host: config.host,
    port: config.port,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start server: ${message}`);
  closeDatabase();
  process.exit(1);
}

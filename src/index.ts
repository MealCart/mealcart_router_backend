import { createApp } from "./app.js";
import { env, isDev } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { checkDbConnection, closeDb } from "./db/pool.js";

async function main() {
  try {
    await checkDbConnection();
  } catch (err) {
    logger.error({ err }, "❌ Could not connect to Postgres. Check DB_* env vars.");
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, cors: isDev ? "dev-friendly" : "configured" },
      `🚀 Mealcart API listening on http://localhost:${env.PORT}`,
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down…");
    server.close(async (err) => {
      if (err) {
        logger.error({ err }, "Error during server close");
        process.exit(1);
      }
      try {
        await closeDb();
      } catch (e) {
        logger.error({ err: e }, "Error closing DB pool");
      }
      logger.info("Server closed");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("Forced shutdown after 10s");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
    shutdown("uncaughtException");
  });
}

main();
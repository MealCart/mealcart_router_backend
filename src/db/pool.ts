import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const { Pool } = pg;

export const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected Postgres pool error");
});

/** One-shot connectivity check on boot. */
export async function checkDbConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    logger.info("✅ Postgres connected");
  } finally {
    client.release();
  }
}

/** Graceful shutdown. */
export async function closeDb(): Promise<void> {
  await pool.end();
  logger.info("Postgres pool closed");
}
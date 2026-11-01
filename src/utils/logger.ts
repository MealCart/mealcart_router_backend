import pino from "pino";
import { env, isDev } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization", 'req.headers["x-api-token"]', 'res.headers["set-cookie"]', "req.body.password"],
    censor: "[REDACTED]",
  },
  transport: isDev
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l" },
      }
    : undefined,
});
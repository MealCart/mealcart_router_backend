import pinoHttp from "pino-http";
import { logger } from "../utils/logger.js";

export const requestLoggerMiddleware = pinoHttp({
  logger,
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} → ${res.statusCode}`;
  },
  autoLogging: {
    ignore: (req) => req.url === "/api/health",
  },
});
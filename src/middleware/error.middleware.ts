import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../types/api.types.js";
import { logger } from "../utils/logger.js";
import { isDev } from "../config/env.js";

/**
 * Central error handler. Every thrown error (sync or async) ends up here.
 * Controllers should `throw new ApiError(...)` for known cases.
 */
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ApiError) {
    if (err.status >= 500) {
      logger.error({ err, code: err.code }, err.message);
    } else {
      logger.warn({ code: err.code, message: err.message }, "api error");
    }
    return res.status(err.status).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  // Unexpected error
  logger.error({ err }, "Unhandled error");
  const message = err instanceof Error ? err.message : "Internal server error";
  return res.status(500).json({
    ok: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: isDev ? message : "Something went wrong",
      details: isDev && err instanceof Error ? err.stack : undefined,
    },
  });
}

/**
 * 404 handler — mount AFTER all routes.
 */
export function notFoundMiddleware(req: Request, res: Response) {
  return res.status(404).json({
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
}
import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";
import { ApiError } from "../types/api.types.js";

/**
 * Returns Express middleware that parses and validates req.body against a Zod schema.
 * On success, replaces req.body with the typed parsed value.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      return next(
        new ApiError(400, "VALIDATION_ERROR", "Invalid request body", details),
      );
    }
    req.body = parsed.data;
    next();
  };
}
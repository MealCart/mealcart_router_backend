import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { ApiError } from "../types/api.types.js";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Fixed-window rate limiter, per-IP, per-window.
 * Window = 60 seconds. Max = env.ROUTE_RATE_LIMIT_PER_MIN.
 */
export function rateLimitMiddleware(req: Request, _res: Response, next: NextFunction) {
  const max = env.ROUTE_RATE_LIMIT_PER_MIN;
  if (max <= 0) return next();

  const ip = (req.ip ?? "unknown").toString();
  const now = Date.now();
  const windowMs = 60_000;

  let bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(ip, bucket);
  }

  bucket.count += 1;

  if (bucket.count > max) {
    const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
    return next(
      new ApiError(
        429,
        "RATE_LIMITED",
        `Too many requests. Try again in ${retryAfterSec}s.`,
        { retryAfterSeconds: retryAfterSec },
      ),
    );
  }

  next();
}

/** For tests + long-running servers to free memory */
export function cleanupRateLimitBuckets() {
  const now = Date.now();
  for (const [ip, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(ip);
  }
}
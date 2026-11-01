import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate.middleware.js";
import { authMiddleware, sessionCookie, sessionToken } from "../middleware/auth.middleware.js";
import { authenticate, revokeSession } from "../services/auth.service.js";
import { asyncHandler } from "../utils/async-handler.js";

export const authRouter = Router();
const attempts = new Map<string, { count: number; until: number }>();
authRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
authRouter.post("/auth/login", (req, res, next) => {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  const key = req.ip ?? "unknown";
  let bucket = attempts.get(key);
  if (!bucket) { bucket = { count: 0, until: now + 15 * 60_000 }; attempts.set(key, bucket); }
  if (++bucket.count > 20) {
    res.setHeader("Retry-After", Math.ceil((bucket.until - now) / 1000));
    res.status(429).json({ ok: false, error: { code: "RATE_LIMITED", message: "Too many login attempts. Please try again later." } });
    return;
  }
  next();
}, validateBody(z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= 72, "Password exceeds bcrypt's 72-byte limit"),
  remember: z.boolean().default(false),
})), asyncHandler(async (req, res) => {
  const result = await authenticate(req.body.email, req.body.password, req.body.remember);
  const oldToken = sessionToken(req);
  if (oldToken) await revokeSession(oldToken);
  sessionCookie(res, result.token, req.body.remember ? result.lifetimeSeconds : undefined);
  res.json({ ok: true, data: result.user });
}));
authRouter.get("/auth/me", authMiddleware, (_req, res) => { res.json({ ok: true, data: res.locals.user }); });
authRouter.post("/auth/logout", asyncHandler(async (req, res) => {
  await revokeSession(sessionToken(req));
  sessionCookie(res, "");
  res.status(204).send();
}));

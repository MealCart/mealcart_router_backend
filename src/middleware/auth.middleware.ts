import type { Request, Response, NextFunction } from "express";
import { env, corsOrigins } from "../config/env.js";
import { ApiError } from "../types/api.types.js";
import { sessionUser } from "../services/auth.service.js";
const cookieName = "mealcart_session";
export function sessionToken(req: Request): string {
  const cookies = (req.headers.cookie ?? "").split(";");
  return cookies.map(value => value.trim()).find(value => value.startsWith(cookieName + "="))?.slice(cookieName.length + 1) ?? "";
}
export function sessionCookie(res: Response, token: string, lifetimeSeconds?: number) {
  if (env.AUTH_COOKIE_SAME_SITE === "none" && !env.AUTH_COOKIE_SECURE) throw new Error("SameSite=None requires AUTH_COOKIE_SECURE=true");
  const options = { httpOnly: true, secure: env.AUTH_COOKIE_SECURE, sameSite: env.AUTH_COOKIE_SAME_SITE, path: "/api" } as const;
  if (!token) res.clearCookie(cookieName, options);
  else res.cookie(cookieName, token, { ...options, ...(lifetimeSeconds ? { maxAge: lifetimeSeconds * 1000 } : {}) });
}
// Required for every cookie-authenticated mutation, including login/logout.
// Explicit origins prevent login CSRF as well as cross-site writes.
export function requireTrustedOrigin(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (!origin || !corsOrigins.includes(origin)) return next(new ApiError(403, "UNTRUSTED_ORIGIN", "Request origin is not allowed."));
  next();
}
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  void sessionUser(sessionToken(req)).then(user => {
    if (!user) return next(new ApiError(401, "UNAUTHORIZED", "Please sign in."));
    res.setHeader("Cache-Control", "no-store");
    res.locals.user = user;
    next();
  }).catch(next);
}

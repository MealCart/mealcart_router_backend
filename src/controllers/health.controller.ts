import type { Request, Response } from "express";
import { env } from "../config/env.js";

export function healthCheck(_req: Request, res: Response) {
  res.json({
    ok: true,
    data: {
      status: "up",
      env: env.NODE_ENV,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    },
  });
}
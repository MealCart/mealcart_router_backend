import type { Request, Response } from "express";
import * as service from "../services/stops.service.js";
import { ApiError } from "../types/api.types.js";

export async function listStopsController(req: Request, res: Response) {
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "BAD_DATE", "date query is required (YYYY-MM-DD)");
  }
  const stops = await service.listStopsForDate(date);
  res.json({ ok: true, data: stops });
}
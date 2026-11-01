import type { Request, Response } from "express";
import { planRoute } from "../services/routing.service.js";
import type { PlanRouteInput } from "../validators/route.validator.js";
import { ApiError } from "../types/api.types.js";

export async function planRouteController(req: Request, res: Response) {
  const input = req.body as PlanRouteInput;

  // Guaranteed unique ids + shape by validator; guard against duplicate ids (validator doesn't enforce)
  const ids = new Set(input.jobs.map((j) => j.id));
  if (ids.size !== input.jobs.length) {
    throw new ApiError(400, "DUPLICATE_JOB_IDS", "Job IDs must be unique");
  }

  const route = await planRoute({
    depot: input.depot,
    jobs: input.jobs,
    optimize: input.optimize,
    viaPoints: input.viaPoints,
  });

  res.json({ ok: true, data: route });
}
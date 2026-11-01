import type { Request, Response } from "express";
import * as service from "../services/route-plan.service.js";
import * as model from "../models/route-plan.model.js";
import type { CreateRoutePlanInput } from "../validators/route-plan.validator.js";
import { ApiError } from "../types/api.types.js";

export async function listRoutePlansController(req: Request, res: Response) {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "BAD_DATE", "date query must be YYYY-MM-DD");
  }
  const plans = await service.listRoutePlans(date);
  res.json({ ok: true, data: plans });
}

export async function getRoutePlanByDriverController(req: Request, res: Response) {
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "BAD_DATE", "date query is required (YYYY-MM-DD)");
  }
  const plan = await service.getPlanForDriver(req.params.driverId, date);
  res.json({ ok: true, data: plan });
}

export async function getRoutePlanController(req: Request, res: Response) {
  const plan = await service.getRoutePlan(req.params.id);
  res.json({ ok: true, data: plan });
}

export async function createRoutePlanController(req: Request, res: Response) {
  const input = req.body as CreateRoutePlanInput;
  const plan = await service.createRoutePlan(input);
  res.status(201).json({ ok: true, data: plan });
}

export async function deleteRoutePlanController(req: Request, res: Response) {
  await service.removeRoutePlan(req.params.id);
  res.status(204).send();
}

export async function deleteRoutePlansForDateController(req: Request, res: Response) {
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "BAD_DATE", "date query is required (YYYY-MM-DD)");
  }
  const deleted = await service.removeRoutePlansForDate(date);
  res.json({ ok: true, data: { deleted } });
}

/**
 * PATCH /api/route-plans/:id/stops/:seq
 * Body: { status?: "Pending" | "Completed" | "Failed" | "Skipped", liveEtaSeconds?: number }
 * Used by the driver app to update one stop in the plan.
 */
export async function updateStopStatusController(req: Request, res: Response) {
  const planId = req.params.id;
  const seq = Number(req.params.seq);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new ApiError(400, "BAD_SEQ", "seq must be a positive integer");
  }

  const body = req.body as { status?: unknown; liveEtaSeconds?: unknown };
  const payload: model.UpdateStopPayload = {};

  if (body.status !== undefined) {
    const allowed: model.StopStatus[] = ["Pending", "Completed", "Failed", "Skipped"];
    if (typeof body.status !== "string" || !allowed.includes(body.status as model.StopStatus)) {
      throw new ApiError(400, "BAD_STATUS", `status must be one of: ${allowed.join(", ")}`);
    }
    payload.status = body.status as model.StopStatus;
  }

  if (body.liveEtaSeconds !== undefined) {
    if (typeof body.liveEtaSeconds !== "number" || !Number.isFinite(body.liveEtaSeconds) || body.liveEtaSeconds < 0) {
      throw new ApiError(400, "BAD_ETA", "liveEtaSeconds must be a non-negative number");
    }
    payload.liveEtaSeconds = Math.round(body.liveEtaSeconds);
  }

  if (payload.status === undefined && payload.liveEtaSeconds === undefined) {
    throw new ApiError(400, "NOTHING_TO_UPDATE", "Provide status and/or liveEtaSeconds");
  }

  const updated = await model.updateStopInPlan(planId, seq, payload);
  if (!updated) {
    throw new ApiError(404, "STOP_NOT_FOUND", `Stop ${seq} not found in plan ${planId}`);
  }

  res.json({ ok: true, data: model.toPublic(updated) });
}
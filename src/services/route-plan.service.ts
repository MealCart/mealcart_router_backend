import { ApiError } from "../types/api.types.js";
import {
  deleteRoutePlanByPublicId,
  deleteRoutePlansForDate,
  findAllRoutePlans,
  findRoutePlanByDriverAndDate,
  findRoutePlanByPublicId,
  insertRoutePlan,
  toPublic,
  type CreateRoutePlanInput,
  type RoutePlanPublic,
} from "../models/route-plan.model.js";
import { findDriverByPublicId } from "../models/driver.model.js";

export async function listRoutePlans(date?: string): Promise<RoutePlanPublic[]> {
  const rows = await findAllRoutePlans(date);
  return rows.map(toPublic);
}

export async function getPlanForDriver(
  driverId: string,
  date: string,
): Promise<RoutePlanPublic | null> {
  const row = await findRoutePlanByDriverAndDate(driverId, date);
  return row ? toPublic(row) : null;
}

export async function getRoutePlan(publicId: string): Promise<RoutePlanPublic> {
  const row = await findRoutePlanByPublicId(publicId);
  if (!row) throw new ApiError(404, "ROUTE_PLAN_NOT_FOUND", `Plan ${publicId} not found`);
  return toPublic(row);
}

export async function createRoutePlan(
  input: CreateRoutePlanInput,
): Promise<RoutePlanPublic> {
  // Validate driver exists
  const driver = await findDriverByPublicId(input.driverId);
  if (!driver) {
    throw new ApiError(404, "DRIVER_NOT_FOUND", `Driver ${input.driverId} not found`);
  }

  // Reject if a plan already exists
  const existing = await findRoutePlanByDriverAndDate(input.driverId, input.planDate);
  if (existing) {
    throw new ApiError(
      409,
      "PLAN_EXISTS",
      `Driver ${input.driverId} already has a plan for ${input.planDate}. Clear it first.`,
    );
  }

  // Enforce driver.max_stops
  if (input.jobIds.length > driver.max_stops) {
    throw new ApiError(
      409,
      "MAX_STOPS_EXCEEDED",
      `Plan has ${input.jobIds.length} stops but ${driver.name}'s limit is ${driver.max_stops}.`,
    );
  }

  const row = await insertRoutePlan(input);
  return toPublic(row);
}

export async function removeRoutePlan(publicId: string): Promise<void> {
  const ok = await deleteRoutePlanByPublicId(publicId);
  if (!ok) throw new ApiError(404, "ROUTE_PLAN_NOT_FOUND", `Plan ${publicId} not found`);
}

export async function removeRoutePlansForDate(date: string): Promise<number> {
  return deleteRoutePlansForDate(date);
}
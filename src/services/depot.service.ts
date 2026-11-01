import { ApiError } from "../types/api.types.js";
import {
  countDriversByDepot,
  deleteDepot as modelDelete,
  findAllDepots,
  findDepotByPublicId,
  insertDepot,
  toPublic,
  updateDepot as modelUpdate,
  type DepotPublic,
} from "../models/depot.model.js";
import type { CreateDepotInput, UpdateDepotInput } from "../validators/depot.validator.js";

export interface DepotWithCount extends DepotPublic {
  driverCount: number;
}

export async function listDepots(): Promise<DepotWithCount[]> {
  const rows = await findAllDepots();
  const counts = await Promise.all(rows.map((r) => countDriversByDepot(r.public_id)));
  return rows.map((r, i) => ({ ...toPublic(r), driverCount: counts[i] }));
}

export async function getDepot(publicId: string): Promise<DepotWithCount> {
  const row = await findDepotByPublicId(publicId);
  if (!row) throw new ApiError(404, "DEPOT_NOT_FOUND", `Depot ${publicId} not found`);
  const driverCount = await countDriversByDepot(publicId);
  return { ...toPublic(row), driverCount };
}

export async function createDepot(input: CreateDepotInput): Promise<DepotWithCount> {
  const row = await insertDepot({
    name: input.name,
    address: input.address,
    city: input.city,
    description: input.description ?? "",
    status: input.status ?? "Active",
    lat: input.lat,
    lng: input.lng,
  });
  return { ...toPublic(row), driverCount: 0 };
}

export async function updateDepot(publicId: string, input: UpdateDepotInput): Promise<DepotWithCount> {
  const existing = await findDepotByPublicId(publicId);
  if (!existing) throw new ApiError(404, "DEPOT_NOT_FOUND", `Depot ${publicId} not found`);
  const row = await modelUpdate(publicId, input);
  if (!row) throw new ApiError(500, "UPDATE_FAILED", "Failed to update depot");
  const driverCount = await countDriversByDepot(publicId);
  return { ...toPublic(row), driverCount };
}

export async function deleteDepot(publicId: string): Promise<void> {
  const ok = await modelDelete(publicId);
  if (!ok) throw new ApiError(404, "DEPOT_NOT_FOUND", `Depot ${publicId} not found`);
}
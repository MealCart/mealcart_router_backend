import bcrypt from "bcryptjs";
import { ApiError } from "../types/api.types.js";
import {
  deleteDriver as modelDelete,
  findAllDrivers,
  findDriverByPublicId,
  findDriverByUsername,
  insertDriver,
  toPublic,
  updateDriver as modelUpdate,
  type DriverPublic,
} from "../models/driver.model.js";
import type { CreateDriverInput, UpdateDriverInput } from "../validators/driver.validator.js";

export async function listDrivers(): Promise<DriverPublic[]> {
  const rows = await findAllDrivers();
  return rows.map(toPublic);
}

export async function getDriver(publicId: string): Promise<DriverPublic> {
  const row = await findDriverByPublicId(publicId);
  if (!row) throw new ApiError(404, "DRIVER_NOT_FOUND", `Driver ${publicId} not found`);
  return toPublic(row);
}

export async function createDriver(input: CreateDriverInput): Promise<DriverPublic> {
  const existing = await findDriverByUsername(input.username);
  if (existing) {
    throw new ApiError(409, "USERNAME_TAKEN", "This username is already taken");
  }
  const row = await insertDriver({
    name: input.name,
    username: input.username,
    phone: input.phone,
    email: input.email,
    depotId: input.depotId,
    availability: input.availability,
    status: input.status,
    maxStops: input.maxStops,
    ...(input.password ? {passwordHash:await bcrypt.hash(input.password,12)} : {}),
  });
  return toPublic(row);
}

export async function updateDriver(
  publicId: string,
  input: UpdateDriverInput,
): Promise<DriverPublic> {
  const existing = await findDriverByPublicId(publicId);
  if (!existing) throw new ApiError(404, "DRIVER_NOT_FOUND", `Driver ${publicId} not found`);

  if (input.username && input.username.toLowerCase() !== existing.username.toLowerCase()) {
    const clash = await findDriverByUsername(input.username);
    if (clash) throw new ApiError(409, "USERNAME_TAKEN", "This username is already taken");
  }

  const row = await modelUpdate(publicId, {
    name: input.name,
    username: input.username,
    phone: input.phone,
    email: input.email,
    depotId: input.depotId,
    availability: input.availability,
    status: input.status,
    maxStops: input.maxStops,
    ...(input.password ? {passwordHash:await bcrypt.hash(input.password,12)} : {}),
  });
  if (!row) throw new ApiError(500, "UPDATE_FAILED", "Failed to update driver");
  return toPublic(row);
}

export async function deleteDriver(publicId: string): Promise<void> {
  const ok = await modelDelete(publicId);
  if (!ok) throw new ApiError(404, "DRIVER_NOT_FOUND", `Driver ${publicId} not found`);
}
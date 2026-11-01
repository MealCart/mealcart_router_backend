import { pool } from "../db/pool.js";

export interface DriverRow {
  id: number;
  public_id: string;
  name: string;
  username: string;
  phone: string;
  email: string;
  password_hash: string | null;
  depot_id: string | null;
  availability: "Available" | "On Route" | "Off Duty";
  status: "Active" | "Inactive";
  max_stops: number;
  created_at: Date;
  updated_at: Date;
}

export interface DriverPublic {
  id: string;
  name: string;
  username: string;
  phone: string;
  email: string;
  depotId: string | null;
  availability: "Available" | "On Route" | "Off Duty";
  status: "Active" | "Inactive";
  maxStops: number;
}

export function toPublic(row: DriverRow): DriverPublic {
  return {
    id: row.public_id,
    name: row.name,
    username: row.username,
    phone: row.phone,
    email: row.email,
    depotId: row.depot_id,
    availability: row.availability,
    status: row.status,
    maxStops: row.max_stops,
  };
}

export async function findAllDrivers(): Promise<DriverRow[]> {
  const { rows } = await pool.query<DriverRow>(
    `SELECT * FROM drivers ORDER BY public_id ASC`,
  );
  return rows;
}

export async function findDriverByPublicId(publicId: string): Promise<DriverRow | null> {
  const { rows } = await pool.query<DriverRow>(
    `SELECT * FROM drivers WHERE public_id = $1`,
    [publicId],
  );
  return rows[0] ?? null;
}

export async function findDriverByUsername(username: string): Promise<DriverRow | null> {
  const { rows } = await pool.query<DriverRow>(
    `SELECT * FROM drivers WHERE LOWER(username) = LOWER($1)`,
    [username],
  );
  return rows[0] ?? null;
}

export async function nextDriverPublicId(): Promise<string> {
  const { rows } = await pool.query<{ max: string | null }>(
    `SELECT MAX(public_id) AS max FROM drivers`,
  );
  const max = rows[0]?.max;
  const n = max ? parseInt(max.replace(/^DRV-/, ""), 10) + 1 : 1;
  return `DRV-${String(n).padStart(2, "0")}`;
}

export interface CreateDriverInput {
  name: string;
  username: string;
  phone: string;
  email: string;
  depotId: string | null;
  availability: DriverRow["availability"];
  status: DriverRow["status"];
  maxStops: number;
  passwordHash?: string | null;
}

export async function insertDriver(input: CreateDriverInput): Promise<DriverRow> {
  const publicId = await nextDriverPublicId();
  const { rows } = await pool.query<DriverRow>(
    `INSERT INTO drivers
      (public_id, name, username, phone, email, password_hash, depot_id, availability, status, max_stops)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      publicId,
      input.name,
      input.username,
      input.phone,
      input.email,
      input.passwordHash ?? null,
      input.depotId,
      input.availability,
      input.status,
      input.maxStops,
    ],
  );
  return rows[0];
}

export interface UpdateDriverInput {
  passwordHash?: string;
  name?: string;
  username?: string;
  phone?: string;
  email?: string;
  depotId?: string | null;
  availability?: DriverRow["availability"];
  status?: DriverRow["status"];
  maxStops?: number;
}

export async function updateDriver(
  publicId: string,
  input: UpdateDriverInput,
): Promise<DriverRow | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.passwordHash !== undefined) { fields.push(`password_hash = $${idx++}`); values.push(input.passwordHash); }
  if (input.name !== undefined) { fields.push(`name = $${idx++}`); values.push(input.name); }
  if (input.username !== undefined) { fields.push(`username = $${idx++}`); values.push(input.username); }
  if (input.phone !== undefined) { fields.push(`phone = $${idx++}`); values.push(input.phone); }
  if (input.email !== undefined) { fields.push(`email = $${idx++}`); values.push(input.email); }
  if (input.depotId !== undefined) { fields.push(`depot_id = $${idx++}`); values.push(input.depotId); }
  if (input.availability !== undefined) { fields.push(`availability = $${idx++}`); values.push(input.availability); }
  if (input.status !== undefined) { fields.push(`status = $${idx++}`); values.push(input.status); }
  if (input.maxStops !== undefined) { fields.push(`max_stops = $${idx++}`); values.push(input.maxStops); }

  if (fields.length === 0) return findDriverByPublicId(publicId);

  fields.push(`updated_at = NOW()`);
  values.push(publicId);

  const { rows } = await pool.query<DriverRow>(
    `UPDATE drivers SET ${fields.join(", ")} WHERE public_id = $${idx} RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

export async function deleteDriver(publicId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM drivers WHERE public_id = $1`,
    [publicId],
  );
  return (rowCount ?? 0) > 0;
}
import { pool } from "../db/pool.js";

export interface DepotRow {
  id: number;
  public_id: string;
  name: string;
  address: string;
  city: string;
  description: string;
  status: "Active" | "Inactive";
  lat: number;
  lng: number;
  created_at: Date;
  updated_at: Date;
}

export interface DepotPublic {
  id: string;
  name: string;
  address: string;
  city: string;
  description: string;
  status: "Active" | "Inactive";
  lat: number;
  lng: number;
}

export function toPublic(row: DepotRow): DepotPublic {
  return {
    id: row.public_id,
    name: row.name,
    address: row.address,
    city: row.city,
    description: row.description,
    status: row.status,
    lat: Number(row.lat),
    lng: Number(row.lng),
  };
}

export async function findAllDepots(): Promise<DepotRow[]> {
  const { rows } = await pool.query<DepotRow>(
    `SELECT * FROM depots ORDER BY public_id ASC`,
  );
  return rows;
}

export async function findDepotByPublicId(publicId: string): Promise<DepotRow | null> {
  const { rows } = await pool.query<DepotRow>(
    `SELECT * FROM depots WHERE public_id = $1`,
    [publicId],
  );
  return rows[0] ?? null;
}

export async function nextDepotPublicId(): Promise<string> {
  const { rows } = await pool.query<{ max: string | null }>(
    `SELECT MAX(public_id) AS max FROM depots`,
  );
  const max = rows[0]?.max;
  const n = max ? parseInt(max.replace(/^DEP-/, ""), 10) + 1 : 1;
  return `DEP-${String(n).padStart(2, "0")}`;
}

export interface CreateDepotInput {
  name: string;
  address: string;
  city: string;
  description: string;
  status: DepotRow["status"];
  lat: number;
  lng: number;
}

export async function insertDepot(input: CreateDepotInput): Promise<DepotRow> {
  const publicId = await nextDepotPublicId();
  const { rows } = await pool.query<DepotRow>(
    `INSERT INTO depots (public_id, name, address, city, description, status, lat, lng)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      publicId,
      input.name,
      input.address,
      input.city,
      input.description,
      input.status,
      input.lat,
      input.lng,
    ],
  );
  return rows[0];
}

export interface UpdateDepotInput {
  name?: string;
  address?: string;
  city?: string;
  description?: string;
  status?: DepotRow["status"];
  lat?: number;
  lng?: number;
}

export async function updateDepot(
  publicId: string,
  input: UpdateDepotInput,
): Promise<DepotRow | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { fields.push(`name = $${idx++}`); values.push(input.name); }
  if (input.address !== undefined) { fields.push(`address = $${idx++}`); values.push(input.address); }
  if (input.city !== undefined) { fields.push(`city = $${idx++}`); values.push(input.city); }
  if (input.description !== undefined) { fields.push(`description = $${idx++}`); values.push(input.description); }
  if (input.status !== undefined) { fields.push(`status = $${idx++}`); values.push(input.status); }
  if (input.lat !== undefined) { fields.push(`lat = $${idx++}`); values.push(input.lat); }
  if (input.lng !== undefined) { fields.push(`lng = $${idx++}`); values.push(input.lng); }

  if (fields.length === 0) return findDepotByPublicId(publicId);

  fields.push(`updated_at = NOW()`);
  values.push(publicId);

  const { rows } = await pool.query<DepotRow>(
    `UPDATE depots SET ${fields.join(", ")} WHERE public_id = $${idx} RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

export async function deleteDepot(publicId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM depots WHERE public_id = $1`,
    [publicId],
  );
  return (rowCount ?? 0) > 0;
}

export async function countDriversByDepot(publicId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM drivers WHERE depot_id = $1`,
    [publicId],
  );
  return Number(rows[0]?.count ?? "0");
}
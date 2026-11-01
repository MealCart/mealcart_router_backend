import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { ApiError } from "../types/api.types.js";
import { allowedUser, bcryptHash, type UserRole } from "./auth-policy.js";

interface UserRow {
  id: number; email: string; password_hash: string; first_name: string | null;
  last_name: string | null; role: string; status: string;
}
export interface AuthUser { id: number; email: string; name: string; role: UserRole }
const dummyHash = bcrypt.hash(randomBytes(32).toString("hex"), 12);
export const digestToken = (token: string) => createHash("sha256").update(token).digest("hex");
export function publicUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email,
    name: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email,
    role: row.role as UserRole };
}
export async function authenticate(email: string, password: string, remember: boolean) {
  const { rows } = await pool.query<UserRow>(
    "SELECT id, email, password_hash, first_name, last_name, role, status FROM users WHERE LOWER(email) = LOWER($1) LIMIT 2", [email]);
  const row = rows.length === 1 ? rows[0] : undefined;
  const stored = row?.password_hash ? bcryptHash(row.password_hash) : null;
  const matches = await bcrypt.compare(password, stored ?? await dummyHash);
  if (!row || !stored || !matches || !allowedUser(row)) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password, or this account does not have access.");
  }
  const token = randomBytes(32).toString("hex");
  const lifetimeSeconds = remember ? 7 * 24 * 3600 : 8 * 3600;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Recheck status and role under lock before creating a session.
    const check = await client.query<UserRow>("SELECT id, email, password_hash, first_name, last_name, role, status FROM users WHERE id = $1 FOR UPDATE", [row.id]);
    const current = check.rows[0];
    if (!current || !allowedUser(current) || current.password_hash !== row.password_hash) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "This account does not have access.");
    }
    await client.query("DELETE FROM user_sessions WHERE user_id = $1 AND expires_at <= NOW()", [row.id]);
    await client.query("INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + $3 * INTERVAL '1 second')", [digestToken(token), row.id, lifetimeSeconds]);
    await client.query("UPDATE users SET last_login = NOW() WHERE id = $1", [row.id]);
    await client.query("COMMIT");
    return { user: publicUser(current), token, lifetimeSeconds };
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}
export async function sessionUser(token: string): Promise<AuthUser | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await pool.query<UserRow>(
    `SELECT u.id, u.email, u.password_hash, u.first_name, u.last_name, u.role, u.status
     FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`, [digestToken(token)]);
  const row = rows[0];
  return row && allowedUser(row) ? publicUser(row) : null;
}
export async function revokeSession(token: string) {
  if (/^[a-f0-9]{64}$/.test(token)) await pool.query("DELETE FROM user_sessions WHERE token_hash = $1", [digestToken(token)]);
}

import { pool } from "../db/pool.js";
import { ApiError } from "../types/api.types.js";
import type { RouteSettingsInput } from "../validators/settings.validator.js";

export interface RouteSettings {
  startTime: string;
  stopDuration: number;
  version: number;
}
const selection = `to_char(start_time,'HH24:MI') AS "startTime",
 stop_duration_minutes AS "stopDuration", version`;

export async function getRouteSettings(): Promise<RouteSettings> {
  const { rows } = await pool.query<RouteSettings>(`SELECT ${selection} FROM mealcart_route_settings WHERE id=1`);
  if (!rows[0]) throw new ApiError(503,"SETTINGS_NOT_INITIALIZED","Run the route-settings SQL migration before using settings.");
  return rows[0];
}
export async function saveRouteSettings(input: RouteSettingsInput, userId: number): Promise<RouteSettings> {
  const { rows } = await pool.query<RouteSettings>(
    `UPDATE mealcart_route_settings SET start_time=$1::time,stop_duration_minutes=$2,
     version=version+1,updated_by=$3,updated_at=NOW()
     WHERE id=1 AND version=$4 RETURNING ${selection}`,
    [input.startTime,input.stopDuration,userId,input.version],
  );
  if (!rows[0]) throw new ApiError(409,"SETTINGS_CHANGED","Settings changed or are not initialized. Reload settings before saving again.");
  return rows[0];
}

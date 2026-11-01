import type { RouteViaPoint } from "../types/route.types.js";
import { ApiError } from "../types/api.types.js";
import { pool } from "../db/pool.js";

export interface RoutePlanLegRow {
  durationSeconds: number;
  distanceMeters: number;
}

export type StopStatus = "Pending" | "Completed" | "Failed" | "Skipped";

export interface StopArrivalRow {
  stopId: string;
  seq: number;
  arrivalSecondsFromMidnight: number;
  travelSecondsFromPrev: number;
  distanceMetersFromPrev: number;
  cumulativeDistanceMeters: number;
  cumulativeDurationSeconds: number;
  // Enriched on insert:
  liveEtaSeconds: number;
  status: StopStatus;
}

/** What the client sends — status/liveEtaSeconds optional, server fills them. */
export interface StopArrivalInput {
  stopId: string;
  seq: number;
  arrivalSecondsFromMidnight: number;
  travelSecondsFromPrev: number;
  distanceMetersFromPrev: number;
  cumulativeDistanceMeters: number;
  cumulativeDurationSeconds: number;
  liveEtaSeconds?: number;
  status?: StopStatus;
}

export interface RoutePlanRow {
  id: number;
  public_id: string;
  driver_id: string;
  plan_date: string;
  status: "Draft" | "Planned";
  distance_meters: number;
  duration_seconds: number;
  encoded_polyline: string;
  job_ids: string[];
  legs: RoutePlanLegRow[];
  stop_arrivals: StopArrivalRow[];
  manual: boolean;
  via_points: RouteViaPoint[];
  route_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface RoutePlanPublic {
  id: string;
  driverId: string;
  planDate: string;
  status: "Draft" | "Planned";
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
  jobIds: string[];
  legs: RoutePlanLegRow[];
  stopArrivals: StopArrivalRow[];
  manual: boolean;
  viaPoints?: RouteViaPoint[];
  version: number;
}

export function toPublic(row: RoutePlanRow): RoutePlanPublic {
  return {
    id: row.public_id,
    driverId: row.driver_id,
    planDate: row.plan_date,
    status: row.status,
    distanceMeters: row.distance_meters,
    durationSeconds: row.duration_seconds,
    encodedPolyline: row.encoded_polyline,
    jobIds: row.job_ids,
    legs: row.legs,
    stopArrivals: row.stop_arrivals,
    manual: row.manual,
    viaPoints: row.via_points ?? [],
    version: row.route_version,
  };
}

export async function findAllRoutePlans(date?: string): Promise<RoutePlanRow[]> {
  if (date) {
    const { rows } = await pool.query<RoutePlanRow>(
      `SELECT * FROM route_plans WHERE plan_date = $1 ORDER BY driver_id ASC`,
      [date],
    );
    return rows;
  }
  const { rows } = await pool.query<RoutePlanRow>(
    `SELECT * FROM route_plans ORDER BY plan_date DESC, driver_id ASC`,
  );
  return rows;
}

export async function findRoutePlanByDriverAndDate(
  driverId: string,
  date: string,
): Promise<RoutePlanRow | null> {
  const { rows } = await pool.query<RoutePlanRow>(
    `SELECT * FROM route_plans WHERE driver_id = $1 AND plan_date = $2`,
    [driverId, date],
  );
  return rows[0] ?? null;
}

export async function findRoutePlanByPublicId(publicId: string): Promise<RoutePlanRow | null> {
  const { rows } = await pool.query<RoutePlanRow>(
    `SELECT * FROM route_plans WHERE public_id = $1`,
    [publicId],
  );
  return rows[0] ?? null;
}

export async function nextRoutePlanPublicId(): Promise<string> {
  const { rows } = await pool.query<{ max: string | null }>(
    `SELECT MAX(public_id) AS max FROM route_plans`,
  );
  const max = rows[0]?.max;
  const n = max ? parseInt(max.replace(/^RP-/, ""), 10) + 1 : 1;
  return `RP-${String(n).padStart(4, "0")}`;
}

export interface CreateRoutePlanInput {
  driverId: string;
  planDate: string;
  status: "Draft" | "Planned";
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
  jobIds: string[];
  legs: RoutePlanLegRow[];
  stopArrivals: StopArrivalInput[];
  manual: boolean;
  viaPoints?: RouteViaPoint[];
}

/** Enrich incoming stopArrivals with status + liveEtaSeconds. Idempotent. */
function enrichStopArrivals(input: StopArrivalInput[]): StopArrivalRow[] {
  return input.map((s) => ({
    stopId: s.stopId,
    seq: s.seq,
    arrivalSecondsFromMidnight: s.arrivalSecondsFromMidnight,
    travelSecondsFromPrev: s.travelSecondsFromPrev,
    distanceMetersFromPrev: s.distanceMetersFromPrev,
    cumulativeDistanceMeters: s.cumulativeDistanceMeters,
    cumulativeDurationSeconds: s.cumulativeDurationSeconds,
    liveEtaSeconds: s.liveEtaSeconds ?? s.arrivalSecondsFromMidnight,
    status: s.status ?? "Pending",
  }));
}

export async function insertRoutePlan(input: CreateRoutePlanInput): Promise<RoutePlanRow> {
  const publicId = await nextRoutePlanPublicId();
  const enriched = enrichStopArrivals(input.stopArrivals);
  const { rows } = await pool.query<RoutePlanRow>(
    `INSERT INTO route_plans
      (public_id, driver_id, plan_date, status, distance_meters, duration_seconds,
       encoded_polyline, job_ids, legs, stop_arrivals, manual, via_points)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb)
     RETURNING *`,
    [
      publicId,
      input.driverId,
      input.planDate,
      input.status,
      input.distanceMeters,
      input.durationSeconds,
      input.encodedPolyline,
      input.jobIds,
      JSON.stringify(input.legs),
      JSON.stringify(enriched),
      input.manual,
      JSON.stringify(input.viaPoints ?? []),
    ],
  );
  return rows[0];
}

export async function deleteRoutePlanByPublicId(publicId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM route_plans WHERE public_id = $1`,
    [publicId],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteRoutePlansForDate(date: string): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM route_plans WHERE plan_date = $1`,
    [date],
  );
  return rowCount ?? 0;
}

/**
 * Update one stop inside the stop_arrivals JSONB array, matched by `seq`.
 * Only touches the fields provided; the rest of the element is preserved.
 */
export interface UpdateStopPayload {
  status?: StopStatus;
  liveEtaSeconds?: number;
}

export async function updateStopInPlan(planPublicId:string,seq:number,payload:UpdateStopPayload):Promise<RoutePlanRow|null> {
 const c=await pool.connect();
 try{
  await c.query("BEGIN");
  const plan=(await c.query<RoutePlanRow>("SELECT * FROM route_plans WHERE public_id=$1 FOR UPDATE",[planPublicId])).rows[0];
  const index=plan?.stop_arrivals.findIndex(s=>s.seq===seq)??-1;
  if(!plan||index<0){await c.query("ROLLBACK");return null;}
  const next={...plan.stop_arrivals[index],...(payload.status!==undefined?{status:payload.status}:{}),...(payload.liveEtaSeconds!==undefined?{liveEtaSeconds:payload.liveEtaSeconds}:{})};
  const row=(await c.query<RoutePlanRow>(`UPDATE route_plans SET stop_arrivals=jsonb_set(stop_arrivals,$1::text[],$2::jsonb,false),route_version=route_version+1,updated_at=NOW() WHERE public_id=$3 RETURNING *`,[`{${index}}`,JSON.stringify(next),planPublicId])).rows[0];
  await c.query("COMMIT");return row??null;
 }catch(err){await c.query("ROLLBACK");throw err;}finally{c.release();}
}

/** Save road edits on an existing, unstarted route without deleting/recreating the plan. */
export async function updateRoutePlanRoads(publicId:string,input:CreateRoutePlanInput & {version:number}):Promise<RoutePlanPublic> {
 const c=await pool.connect();
 try {
  await c.query("BEGIN");
  const old=(await c.query<RoutePlanRow>("SELECT * FROM route_plans WHERE public_id=$1 FOR UPDATE",[publicId])).rows[0];
  if(!old)throw new ApiError(404,"ROUTE_PLAN_NOT_FOUND","Route plan not found.");
  if(old.route_version!==input.version)throw new ApiError(409,"ROUTE_CHANGED","The saved route changed. Reload it before editing again.");
  if(old.stop_arrivals.some(s=>s.status!=="Pending"||s.liveEtaSeconds!==s.arrivalSecondsFromMidnight))throw new ApiError(409,"ROUTE_STARTED","This route has recorded progress. Road edits cannot replace its delivery history.");
  const oldDate=(old.plan_date as unknown) instanceof Date ? (old.plan_date as unknown as Date).toISOString().slice(0,10) : String(old.plan_date).slice(0,10);
  if(old.driver_id!==input.driverId||oldDate!==input.planDate||JSON.stringify(old.job_ids)!==JSON.stringify(input.jobIds))throw new ApiError(409,"ROUTE_STOPS_CHANGED","Road editing must keep the saved driver, date and delivery order unchanged.");
  const row=(await c.query<RoutePlanRow>(`UPDATE route_plans SET distance_meters=$2,duration_seconds=$3,
   encoded_polyline=$4,legs=$5::jsonb,stop_arrivals=$6::jsonb,manual=true,via_points=$7::jsonb,
   route_version=route_version+1,updated_at=NOW() WHERE public_id=$1 RETURNING *`,
   [publicId,input.distanceMeters,input.durationSeconds,input.encodedPolyline,JSON.stringify(input.legs),JSON.stringify(enrichStopArrivals(input.stopArrivals)),JSON.stringify(input.viaPoints??[])])).rows[0];
  await c.query("COMMIT");return toPublic(row);
 }catch(err){await c.query("ROLLBACK");throw err;}finally{c.release();}
}

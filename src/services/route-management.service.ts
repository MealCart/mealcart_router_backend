import { pool } from '../db/pool.js';
import { ApiError } from '../types/api.types.js';
import { toPublic, type RoutePlanRow } from '../models/route-plan.model.js';

export async function listManagedRoutes(date?: string) {
 const rows = (await pool.query<RoutePlanRow & {route_depot_id: string | null}>(`
  SELECT p.*,p.plan_date::text AS plan_date,COALESCE(p.route_depot_id,d.depot_id) AS route_depot_id
  FROM route_plans p LEFT JOIN drivers d ON d.public_id=p.driver_id
  WHERE ($1::date IS NULL OR p.plan_date=$1::date) ORDER BY p.plan_date DESC,p.public_id`, [date ?? null])).rows;
 return rows.map(row => ({...toPublic(row), routeDepotId: row.route_depot_id}));
}

/** Lock the plan and driver rows before transferring custody; retain stop/proof identities. */
export async function manageRoute(id: string, version: number, newDriverId?: string) {
 const c = await pool.connect();
 try {
  await c.query('BEGIN');
  // Driver starts take driver locks before plan locks. Match that order to avoid deadlocks.
  const before = (await c.query('SELECT driver_id FROM route_plans WHERE public_id=$1',[id])).rows[0];
  if (!before) throw new ApiError(404,'ROUTE_NOT_FOUND','This route no longer exists. Refresh the date.');
  const lockedDrivers = (await c.query(`SELECT public_id,status,depot_id FROM drivers WHERE public_id=ANY($1::text[]) ORDER BY public_id FOR UPDATE`, [[before.driver_id,...(newDriverId ? [newDriverId] : [])]])).rows;
  const row = (await c.query<RoutePlanRow & {route_depot_id:string|null}>(`SELECT *,plan_date::text AS plan_date FROM route_plans WHERE public_id=$1 FOR UPDATE`,[id])).rows[0];
  if (!row || row.driver_id !== before.driver_id || row.route_version !== version) throw new ApiError(409,'ROUTE_CHANGED','This route changed. Refresh it before trying again.');
  if (newDriverId === row.driver_id) {await c.query('COMMIT');return {id,driverId:row.driver_id};}
  if (newDriverId) {
   const driver = lockedDrivers.find(d => d.public_id === newDriverId);
   if (!driver || String(driver.status).toLowerCase() !== 'active') throw new ApiError(409,'DRIVER_INACTIVE','Choose an active driver.');
   const conflict = (await c.query(`SELECT public_id FROM route_plans WHERE driver_id=$1 AND plan_date=$2 AND public_id<>$3`,[newDriverId,row.plan_date,id])).rows[0];
   if (conflict) throw new ApiError(409,'DRIVER_HAS_ROUTE',`This driver already has route ${conflict.public_id} for this date. Release and redistribute stops instead.`);
   const active = (await c.query(`SELECT plan_id FROM mealcart_route_execution WHERE driver_id=$1 AND ended_at IS NULL AND plan_id<>$2`,[newDriverId,id])).rows[0];
   if (active) throw new ApiError(409,'DRIVER_BUSY','This driver has another active route. End that session first.');
  }
  await c.query(`INSERT INTO mealcart_route_management_events(plan_id,action,old_driver_id,new_driver_id,route_snapshot)
   VALUES($1,$2,$3,$4,$5::jsonb)`,[id,newDriverId ? 'driver_changed' : 'released',row.driver_id,newDriverId ?? null,JSON.stringify(row)]);
  await c.query(`UPDATE mealcart_route_execution SET ended_at=clock_timestamp() WHERE plan_id=$1 AND plan_created_at=(SELECT created_at::timestamptz FROM route_plans WHERE public_id=$1) AND ended_at IS NULL`,[id]);
  if (newDriverId) {
   const old = lockedDrivers.find(d => d.public_id === row.driver_id);
   await c.query(`UPDATE route_plans SET driver_id=$2,route_depot_id=COALESCE(route_depot_id,$3),route_version=route_version+1,updated_at=clock_timestamp() WHERE public_id=$1`,[id,newDriverId,old?.depot_id ?? null]);
   // Reuse the immutable plan snapshot but require the replacement driver to explicitly Start route.
   await c.query(`UPDATE mealcart_route_execution SET driver_id=$2,ended_at=clock_timestamp(),eta_updated_at=NULL,next_eta_at=clock_timestamp() WHERE plan_id=$1 AND plan_created_at=(SELECT created_at::timestamptz FROM route_plans WHERE public_id=$1)`,[id,newDriverId]);
  } else {
   await c.query('DELETE FROM route_plans WHERE public_id=$1',[id]);
  }
  await c.query('COMMIT');
  return {id,driverId:newDriverId ?? null};
 } catch(error) {await c.query('ROLLBACK');throw error;} finally {c.release();}
}

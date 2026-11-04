import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
import {localClock} from '../lib/delivery-events.js';
import {messaging as cfg} from '../config/delivery-messaging.js';
import {getDriverRoute} from './driver-mobile-routes.service.js';
export async function routeExecution(driverId:string,id:string){
 const result=(await pool.query(`SELECT e.started_at,e.ended_at,e.eta_updated_at,e.last_error,e.request_count FROM route_plans p LEFT JOIN mealcart_route_execution e ON e.plan_id=p.public_id AND e.plan_created_at=p.created_at::timestamptz WHERE p.public_id=$1 AND p.driver_id=$2 AND p.status='Planned'`,[id,driverId])).rows[0];
 if(!result)throw new ApiError(404,'ROUTE_NOT_FOUND','Route unavailable');return result;
}
export async function startRouteExecution(driverId:string,id:string,createdAt:string){
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query('SELECT public_id FROM drivers WHERE public_id=$1 FOR UPDATE',[driverId]);
  const p=(await c.query(`SELECT public_id,created_at,plan_date::text AS date FROM route_plans WHERE public_id=$1 AND driver_id=$2 AND status='Planned' AND created_at::timestamptz=$3::timestamptz FOR UPDATE`,[id,driverId,createdAt])).rows[0];
  if(!p)throw new ApiError(409,'ROUTE_CHANGED','Download the current route before starting');
  if(p.date!==localClock(new Date(),cfg.DELIVERY_TIMEZONE).date)throw new ApiError(409,'WRONG_DATE',`Only today's route (${cfg.DELIVERY_TIMEZONE}) can start live ETA`);
  const gps=(await c.query(`SELECT driver_id FROM mealcart_driver_locations WHERE driver_id=$1 AND tracking_enabled=true AND accuracy<=100 AND captured_at>clock_timestamp()-interval '90 seconds' AND received_at>clock_timestamp()-interval '90 seconds'`,[driverId])).rows[0];
  if(!gps)throw new ApiError(409,'GPS_REQUIRED','Start location sharing on Home and wait for a fresh accurate GPS fix before starting the route');
  await c.query('UPDATE mealcart_route_execution SET ended_at=clock_timestamp() WHERE driver_id=$1 AND ended_at IS NULL AND NOT(plan_id=$2 AND plan_created_at=$3::timestamptz)',[driverId,id,createdAt]);
  await c.query(`INSERT INTO mealcart_route_execution(plan_id,plan_created_at,driver_id) VALUES($1,$2,$3) ON CONFLICT(plan_id,plan_created_at) DO UPDATE SET next_eta_at=CASE WHEN mealcart_route_execution.ended_at IS NULL THEN mealcart_route_execution.next_eta_at ELSE GREATEST(clock_timestamp(),COALESCE(mealcart_route_execution.eta_updated_at,clock_timestamp()-interval '60 seconds')+interval '60 seconds') END,ended_at=NULL`,[id,createdAt,driverId]);
  await c.query('COMMIT');return routeExecution(driverId,id);
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function stopRouteExecution(driverId:string,id:string){await pool.query('UPDATE mealcart_route_execution SET ended_at=clock_timestamp() WHERE plan_id=$1 AND driver_id=$2 AND ended_at IS NULL',[id,driverId]);return routeExecution(driverId,id);}
export interface FailureInput {requestId:string;planCreatedAt:string;stopId:string;reason:string;recordedAt:string}
export async function failDriverStop(driverId:string,id:string,seq:number,input:FailureInput){
 const c=await pool.connect();try{
  await c.query('BEGIN');
  const p=(await c.query(`SELECT *,plan_date::text AS plan_date,created_at::timestamptz=$3::timestamptz AS snapshot_matches FROM route_plans WHERE public_id=$1 AND driver_id=$2 AND status='Planned' FOR UPDATE`,[id,driverId,input.planCreatedAt])).rows[0];
  if(!p||!p.snapshot_matches)throw new ApiError(409,'ROUTE_CHANGED','The saved route was replaced or reassigned. Failure report retained for office review');
  const index=p.stop_arrivals.findIndex((s:any)=>s.seq===seq&&s.stopId===input.stopId),stop=p.stop_arrivals[index],match=/^STP-([JC])([1-9]\d*)$/.exec(input.stopId);
  if(!stop||!match)throw new ApiError(400,'DELIVERY_REQUIRED','Failure reporting requires a delivery or collection stop');
  const old=(await c.query('SELECT *,plan_created_at=$2::timestamptz AS snapshot_matches FROM mealcart_delivery_failures WHERE id=$1',[input.requestId,input.planCreatedAt])).rows[0];
  if(old){if(!old.snapshot_matches||old.plan_id!==id||old.driver_id!==driverId||old.stop_seq!==seq||old.stop_id!==input.stopId||old.reason!==input.reason)throw new ApiError(409,'REQUEST_CONFLICT','Failure receipt belongs to another report');await c.query('COMMIT');return getDriverRoute(driverId,id);}
  if(stop.status!=='Pending')throw new ApiError(409,'STOP_NOT_PENDING','This stop is already completed, failed or skipped');
  const at=Date.parse(input.recordedAt);if(at>Date.now()+300000||at<new Date(p.created_at).getTime()-86400000)throw new ApiError(409,'CLOCK_INVALID','Check the device clock; report retained');
  const source=match[1]==='J'?'jobs':'collections';
  const job=(await c.query(`SELECT id,status,do_number FROM ${source} WHERE id=$1 FOR UPDATE`,[match[2]])).rows[0];
  if(!job||['completed','failed','cancelled','canceled'].includes(String(job.status).toLowerCase()))throw new ApiError(409,'JOB_CHANGED','Job is unavailable or no longer pending');
  await c.query(`INSERT INTO mealcart_delivery_failures(id,plan_id,plan_created_at,stop_seq,stop_id,job_id,delivery_date,driver_id,reason,recorded_at,source_kind,do_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[input.requestId,id,input.planCreatedAt,seq,input.stopId,job.id,String(p.plan_date).slice(0,10),driverId,input.reason,input.recordedAt,source,job.do_number]);
  const updated={...stop,status:'Failed',failureRequestId:input.requestId,failureReason:input.reason,failedAt:input.recordedAt,failedByDriverId:driverId};
  await c.query(`UPDATE route_plans SET stop_arrivals=jsonb_set(stop_arrivals,$1::text[],$2::jsonb),route_version=route_version+1,updated_at=clock_timestamp() WHERE public_id=$3`,[`{${index}}`,JSON.stringify(updated),id]);
  if(source==='jobs')await c.query("UPDATE jobs SET status='failed' WHERE id=$1",[job.id]);
  await c.query("UPDATE mealcart_route_execution SET next_eta_at=LEAST(next_eta_at,clock_timestamp()+interval '60 seconds') WHERE plan_id=$1 AND ended_at IS NULL",[id]);
  await c.query('COMMIT');return getDriverRoute(driverId,id);
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
import type {TrackingPoint} from '../validators/driver-location.validator.js';
export const TRACKING_CHANNEL='mealcart_driver_location';
export function publicLocation(row:any){return{driverId:row.driver_id,trackingEnabled:row.tracking_enabled,lat:row.lat==null?null:Number(row.lat),lng:row.lng==null?null:Number(row.lng),accuracy:row.accuracy==null?null:Number(row.accuracy),speed:row.speed==null?null:Math.round(Number(row.speed)*3.6),heading:row.heading==null?null:Number(row.heading),capturedAt:row.captured_at?new Date(row.captured_at).toISOString():null,receivedAt:row.received_at?new Date(row.received_at).toISOString():null,changedAt:new Date(row.changed_at).toISOString(),version:Number(row.version)};}
export async function latestDriverLocations(){return(await pool.query('SELECT * FROM mealcart_driver_locations ORDER BY driver_id')).rows.map(publicLocation);}
export async function oneDriverLocation(id:string){const row=(await pool.query('SELECT * FROM mealcart_driver_locations WHERE driver_id=$1',[id])).rows[0];return row?publicLocation(row):null;}
const subscribers=new Set<(location:ReturnType<typeof publicLocation>)=>void>();
export function subscribeDriverLocations(fn:(location:ReturnType<typeof publicLocation>)=>void){subscribers.add(fn);return()=>{subscribers.delete(fn);};}
export function publishPublicDriverLocation(value:ReturnType<typeof publicLocation>){for(const fn of subscribers){try{fn(value);}catch{/* one disconnected browser must not affect GPS ingestion */}}}
export function publishDriverLocation(row:any){publishPublicDriverLocation(publicLocation(row));}
async function transaction<T>(driverId:string,run:(client:import('pg').PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const d=(await c.query('SELECT public_id FROM drivers WHERE public_id=$1 AND status=\'Active\' FOR UPDATE',[driverId])).rows[0];if(!d)throw new ApiError(403,'DRIVER_INACTIVE','Driver account is inactive.');const result=await run(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
async function notify(c:import('pg').PoolClient,id:string){await c.query('SELECT pg_notify($1,$2)',[TRACKING_CHANNEL,JSON.stringify({driverId:id})]);}
export async function startDriverTracking(driverId:string,sessionId:string){
 const result=await transaction(driverId,async c=>{
  const existing=(await c.query('SELECT * FROM mealcart_driver_tracking_sessions WHERE id=$1',[sessionId])).rows[0];
  if(existing&&(existing.driver_id!==driverId||existing.ended_at))throw new ApiError(409,'TRACKING_SESSION_ENDED','This tracking session ended. Start a new work session.');
  const current=(await c.query('SELECT * FROM mealcart_driver_locations WHERE driver_id=$1',[driverId])).rows[0];
  if(existing&&current?.session_id===sessionId&&current.tracking_enabled)return current;
  if(existing)throw new ApiError(409,'TRACKING_SESSION_REPLACED','A newer tracking session is active.');
  await c.query('UPDATE mealcart_driver_tracking_sessions SET ended_at=clock_timestamp() WHERE driver_id=$1 AND ended_at IS NULL',[driverId]);
  await c.query('INSERT INTO mealcart_driver_tracking_sessions(id,driver_id) VALUES($1,$2)',[sessionId,driverId]);
  const row=(await c.query(`INSERT INTO mealcart_driver_locations(driver_id,session_id,tracking_enabled) VALUES($1,$2,true) ON CONFLICT(driver_id) DO UPDATE SET session_id=$2,tracking_enabled=true,received_at=NULL,sample_id=NULL,changed_at=clock_timestamp(),version=mealcart_driver_locations.version+1 RETURNING *`,[driverId,sessionId])).rows[0];await notify(c,driverId);return row;
 });publishDriverLocation(result);return publicLocation(result);
}
export async function stopDriverTracking(driverId:string,sessionId:string){
 const result=await transaction(driverId,async c=>{
  const session=(await c.query('SELECT * FROM mealcart_driver_tracking_sessions WHERE id=$1',[sessionId])).rows[0];
  if(session&&session.driver_id!==driverId)throw new ApiError(403,'WRONG_TRACKING_SESSION','This session belongs to another driver.');
  // A stop received before its delayed start prevents that old start re-enabling tracking.
  if(!session)await c.query('INSERT INTO mealcart_driver_tracking_sessions(id,driver_id,ended_at) VALUES($1,$2,clock_timestamp())',[sessionId,driverId]);
  else await c.query('UPDATE mealcart_driver_tracking_sessions SET ended_at=COALESCE(ended_at,clock_timestamp()) WHERE id=$1',[sessionId]);
  const row=(await c.query(`UPDATE mealcart_driver_locations SET tracking_enabled=false,changed_at=clock_timestamp(),version=version+1 WHERE driver_id=$1 AND session_id=$2 AND tracking_enabled=true RETURNING *`,[driverId,sessionId])).rows[0];if(row)await notify(c,driverId);return row;
 });if(result)publishDriverLocation(result);return{stopped:true};
}
export async function recordDriverLocation(driverId:string,point:TrackingPoint){
 const captured=Date.parse(point.capturedAt),age=Date.now()-captured;
 if(age < -30000)throw new ApiError(400,'DEVICE_CLOCK_INVALID','Your phone clock is ahead. Enable automatic date and time.');
 if(age>120000)return{accepted:false,reason:'expired'};
 const result=await transaction(driverId,async c=>{
  const session=(await c.query('SELECT * FROM mealcart_driver_tracking_sessions WHERE id=$1 AND driver_id=$2 AND ended_at IS NULL',[point.sessionId,driverId])).rows[0];
  const current=(await c.query('SELECT * FROM mealcart_driver_locations WHERE driver_id=$1',[driverId])).rows[0];
  if(!session||!current?.tracking_enabled||current.session_id!==point.sessionId)throw new ApiError(409,'TRACKING_SESSION_ENDED','Tracking stopped or a newer work session replaced it.');
  if(current.sample_id===point.sampleId||current.sample_id&&current.captured_at&&captured<=new Date(current.captured_at).getTime())return{accepted:false,reason:'out_of_order',row:null};
  const row=(await c.query(`UPDATE mealcart_driver_locations SET lat=$2,lng=$3,accuracy=$4,speed=$5,heading=$6,captured_at=$7::timestamptz,received_at=clock_timestamp(),changed_at=clock_timestamp(),sample_id=$8,version=version+1 WHERE driver_id=$1 RETURNING *`,[driverId,point.lat,point.lng,point.accuracy,point.speed,point.heading,point.capturedAt,point.sampleId])).rows[0];await notify(c,driverId);return{accepted:true,reason:'saved',row};
 });if(result.row)publishDriverLocation(result.row);return{accepted:result.accepted,reason:result.reason};
}

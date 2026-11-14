import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
import {toPublic} from '../models/route-plan.model.js';
import {reverseCalculatedRoute,reverseSavedArrivals} from '../lib/reverse-sequence.js';
const conflict=(message:string)=>new ApiError(409,'REVERSE_SEQUENCE_BLOCKED',message);
export async function reverseSavedRoute(id:string,version:number,requestId:string,actorId:string){
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  const before=(await c.query('SELECT driver_id FROM route_plans WHERE public_id=$1',[id])).rows[0];if(!before)throw new ApiError(404,'ROUTE_NOT_FOUND','This route no longer exists.');
  await c.query('SELECT public_id FROM drivers WHERE public_id=$1 FOR UPDATE',[before.driver_id]);
  await c.query('LOCK TABLE route_plans IN EXCLUSIVE MODE');
  const previous=(await c.query('SELECT * FROM mealcart_route_transfer_events WHERE id=$1',[requestId])).rows[0];
  if(previous){const source=previous.before_routes?.[0],saved=previous.after_routes?.[0];if(String(previous.actor_id)!==actorId||source?.public_id!==id||source?.route_version!==version||source?._operation!=='reverse-sequence'||saved?.public_id!==id)throw conflict('This request belongs to a different route change. Reload the route.');await c.query('COMMIT');return toPublic(saved);}
  const row=(await c.query(`SELECT *,plan_date::text AS plan_date,to_char(created_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS snapshot FROM route_plans WHERE public_id=$1 FOR UPDATE`,[id])).rows[0];
  if(!row||row.driver_id!==before.driver_id||row.route_version!==version)throw conflict('This route changed. Refresh it before reversing.');
  if(row.status!=='Planned'||row.stop_arrivals.some((s:any)=>s.status!=='Pending'||s.liveEtaSeconds!==s.arrivalSecondsFromMidnight||s.proof||s.completedAt||s.failureRequestId))throw conflict('This route has recorded progress. Its stop sequence cannot be reversed.');
  const started=(await c.query('SELECT 1 FROM mealcart_route_execution WHERE plan_id=$1 AND plan_created_at=$2::timestamptz AND started_at IS NOT NULL LIMIT 1',[id,row.snapshot])).rows;
  if(started.length)throw conflict('This route has already been started. Its sequence cannot be reversed.');
  const evidence=(await c.query(`SELECT 1 FROM mealcart_parcel_scans WHERE plan_id=$1 AND plan_created_at=$2::timestamptz UNION ALL SELECT 1 FROM mealcart_delivery_completions WHERE plan_id=$1 AND plan_created_at=$2::timestamptz UNION ALL SELECT 1 FROM mealcart_collection_completions WHERE plan_id=$1 AND plan_created_at=$2::timestamptz UNION ALL SELECT 1 FROM mealcart_delivery_failures WHERE plan_id=$1 AND plan_created_at=$2::timestamptz LIMIT 1`,[id,row.snapshot])).rows;
  if(evidence.length)throw conflict('This route has driver scans or completion evidence. Its sequence cannot be reversed.');
  if(row.job_ids.some((id:string)=>!/^STP-[JC][1-9]\d*$/.test(id)))throw conflict('This route contains legacy stop references. Recalculate it before reversing.');
  for(const kind of ['J','C']){
   const ids=row.job_ids.filter((id:string)=>id.startsWith('STP-'+kind)).map((id:string)=>Number(id.slice(5)));
   if(!ids.length)continue;
   const sources=(await c.query(`SELECT id,status,scheduled_date::text AS scheduled_date FROM ${kind==='J'?'jobs':'collections'} WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,[ids])).rows;
   if(sources.length!==ids.length||sources.some((s:any)=>s.scheduled_date!==row.plan_date||['completed','delivered','failed','cancelled','canceled'].includes(String(s.status).toLowerCase())))throw conflict('A source order changed or is no longer pending. Refresh the route before reversing.');
  }
  const road={jobIds:row.job_ids,legs:row.legs,encodedPolyline:row.encoded_polyline,distanceMeters:row.distance_meters,durationSeconds:row.duration_seconds,viaPoints:row.via_points??[]};
  let reversed,arrivals;try{reversed=reverseCalculatedRoute(road);arrivals=reverseSavedArrivals(road,row.stop_arrivals,reversed);}catch(e){throw conflict((e as Error).message);}
  const updated=(await c.query(`UPDATE route_plans SET job_ids=$2,legs=$3::jsonb,encoded_polyline=$4,stop_arrivals=$5::jsonb,via_points=$6::jsonb,manual=true,route_version=route_version+1,updated_at=clock_timestamp() WHERE public_id=$1 RETURNING *,plan_date::text AS plan_date`,[id,reversed.jobIds,JSON.stringify(reversed.legs),reversed.encodedPolyline,JSON.stringify(arrivals),JSON.stringify(reversed.viaPoints)])).rows[0];
  await c.query('INSERT INTO mealcart_route_transfer_events(id,actor_id,plan_date,before_routes,after_routes) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[requestId,actorId,row.plan_date,JSON.stringify([{...row,_operation:'reverse-sequence'}]),JSON.stringify([updated])]);
  await c.query('COMMIT');return toPublic(updated);
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(['55P03','40P01','40001'].includes(String((e as {code?:string}).code)))throw conflict('Another planner or driver is updating this route. Refresh and try again.');throw e;}finally{c.release();}
}

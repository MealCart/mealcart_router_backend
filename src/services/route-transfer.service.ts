import {createHash,randomUUID} from 'node:crypto';
import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
import {planRoute} from './routing.service.js';
import {toPublic} from '../models/route-plan.model.js';
type Db={query:(sql:string,args?:any[])=>Promise<any>};
export type TransferInput={routes:{id:string;version:number;jobIds:string[]}[]};
const error=(message:string)=>new ApiError(409,'ROUTE_TRANSFER_CONFLICT',message);
const stopIds=(p:any)=>p.stop_arrivals.filter((s:any)=>s.stopId!=='__DEPOT__').sort((a:any,b:any)=>a.seq-b.seq).map((s:any)=>s.stopId) as string[];
export function stableTransferSequences(ids:string[],locked:Map<string,any>){let next=1;return ids.map(id=>{const fixed=locked.get(id);if(fixed&&fixed.seq<next)throw error('Recorded stops must keep their sequence. Place extra stops after the locked stop.');const seq=fixed?.seq??next;next=seq+1;return seq;});}
async function state(db:Db,ids:string[],additional:string[]=[]){
 const plans=(await db.query(`SELECT *,plan_date::text AS plan_date,to_char(created_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS snapshot FROM route_plans WHERE public_id=ANY($1::text[]) ORDER BY public_id`,[ids])).rows;
 if(plans.length!==ids.length||plans.some((p:any)=>p.status!=='Planned')||new Set(plans.map((p:any)=>p.plan_date)).size!==1)throw error('Select one or two saved routes for the same date.');
 const date=plans[0].plan_date;
 const all=(await db.query('SELECT public_id,job_ids,stop_arrivals FROM route_plans WHERE plan_date=$1 ORDER BY public_id',[date])).rows;
 const claimed=new Map<string,string>();for(const p of all)for(const id of stopIds(p)){if(claimed.has(id)&&claimed.get(id)!==p.public_id)throw error('This date has a stop on multiple saved routes. Resolve that duplicate first.');claimed.set(id,p.public_id);}
 const locked=new Map<string,any>();
 for(const p of plans){
  const evidence=(await db.query(`SELECT stop_seq FROM mealcart_parcel_scans WHERE plan_id=$1 AND plan_created_at=$2::timestamptz UNION SELECT stop_seq FROM mealcart_delivery_completions WHERE plan_id=$1 AND plan_created_at=$2::timestamptz UNION SELECT stop_seq FROM mealcart_delivery_failures WHERE plan_id=$1 AND plan_created_at=$2::timestamptz`,[p.public_id,p.snapshot])).rows;
  const seqs=new Set(evidence.map((s:any)=>s.stop_seq));for(const s of p.stop_arrivals)if(s.stopId!=='__DEPOT__'&&(s.status!=='Pending'||seqs.has(s.seq)))locked.set(s.stopId,{...s,owner:p.public_id});
 }
 const sources:Record<string,any>={};
 for(const id of [...new Set([...plans.flatMap(stopIds),...additional])].sort()){
  const match=/^STP-([JC])([1-9]\d*)$/.exec(id);if(!match)throw error('Invalid delivery or collection reference.');
  const rows=(await db.query(`SELECT to_jsonb(s) AS value FROM ${match[1]==='J'?'jobs':'collections'} s WHERE id=$1`,[match[2]])).rows;
  if(rows.length!==1)throw error(`${id}: source order is unavailable or its ID is duplicated.`);sources[id]=rows[0].value;
 }
 const drivers=(await db.query('SELECT public_id,status,depot_id FROM drivers WHERE public_id=ANY($1::text[]) ORDER BY public_id',[plans.map((p:any)=>p.driver_id)])).rows;
 const depots:Record<string,any>={};for(const p of plans){const d=drivers.find((d:any)=>d.public_id===p.driver_id);if(!d)throw error('A selected driver no longer exists.');const depot=(await db.query('SELECT public_id,lat,lng FROM depots WHERE public_id=$1',[p.route_depot_id??d.depot_id])).rows[0];if(!depot||depot.lat==null||depot.lng==null||!Number.isFinite(Number(depot.lat))||!Number.isFinite(Number(depot.lng)))throw error('Each selected route needs a valid start/return depot.');depots[p.public_id]=depot;}
 const settings=(await db.query('SELECT to_jsonb(s) AS value FROM mealcart_route_settings s WHERE id=1')).rows[0]?.value;
 if(!settings||!/^\d{2}:\d{2}/.test(String(settings.start_time??''))||!Number.isFinite(Number(settings.stop_duration_minutes)))throw error('Route start-time/service-time settings are unavailable. Refresh settings first.');
 const serial={plans,all:all.map((p:any)=>({public_id:p.public_id,job_ids:p.job_ids,stop_ids:stopIds(p)})),locked:[...locked],sources,drivers,depots,settings};
 const hash=createHash('sha256').update(JSON.stringify(serial)).digest('hex');
 return {...serial,locked,claimed,date,hash};
}
export async function routeTransferState(ids:string[]){const s=await state(pool,ids);return{plans:s.plans.map((p:any)=>({...toPublic(p),routeDepotId:p.route_depot_id})),lockedIds:[...s.locked.keys()]};}
function validate(input:TransferInput,s:Awaited<ReturnType<typeof state>>){
 const ids=input.routes.flatMap(r=>r.jobIds);if(new Set(ids).size!==ids.length)throw error('A stop cannot appear in two routes.');
 for(const r of input.routes){const p=s.plans.find((p:any)=>p.public_id===r.id);if(!p||p.route_version!==r.version)throw error('A selected route changed. Reload the editor.');
  if(r.jobIds.length&&String(s.drivers.find((d:any)=>d.public_id===p.driver_id)?.status).toLowerCase()!=='active')throw error('Choose a route belonging to an active driver.');
  for(const id of r.jobIds){const owner=s.claimed.get(id);if(owner&&!input.routes.some(r=>r.id===owner))throw error(`${id} belongs to another saved route. Select that route before moving it.`);
   const locked=s.locked.get(id);if(locked&&locked.owner!==r.id)throw error('Completed, failed and scanned stops cannot move to another route.');
   const source=s.sources[id];if(!source)throw error('The source order changed.');
   if(!locked&&(String(source.scheduled_date).slice(0,10)!==s.date||['completed','failed','cancelled','canceled'].includes(String(source.status).toLowerCase())))throw error(`${id} is not a pending order for this planning date.`);
  }
  for(const [id,locked] of s.locked)if(locked.owner===r.id&&!r.jobIds.includes(id))throw error('A stop with recorded progress cannot be removed.');
  stableTransferSequences(r.jobIds,s.locked);
 }
}
export async function previewRouteTransfer(input:TransferInput,actorId:string){
 const ids=input.routes.map(r=>r.id),additional=input.routes.flatMap(r=>r.jobIds),s=await state(pool,ids,additional);validate(input,s);
 const results=[];
 for(const request of input.routes){
  const p=s.plans.find((p:any)=>p.public_id===request.id),depot=s.depots[request.id];
  const jobs=request.jobIds.map(id=>{const source=s.sources[id],lat=source.latitude,lng=source.longitude;if(lat==null||lng==null||!Number.isFinite(Number(lat))||!Number.isFinite(Number(lng))||Math.abs(Number(lat))>90||Math.abs(Number(lng))>180)throw error(`${id} has no valid map coordinates.`);return{id,address:String(source.delivery_address??source.collection_address??source.address??id),position:{lat:Number(lat),lng:Number(lng)}};});
  // Stop-specific road choices follow moved stops; each route keeps its depot-return vias.
  const vias=s.plans.flatMap((plan:any)=>(plan.via_points??[]).filter((v:any)=>v.beforeJobId?request.jobIds.includes(v.beforeJobId):plan.public_id===request.id));
  if(vias.length>10||new Set(vias.map((v:any)=>v.id)).size!==vias.length)throw error('This move would exceed the saved road-via limit. Adjust road edits first.');
  const road=jobs.length?await planRoute({depot:{lat:Number(depot.lat),lng:Number(depot.lng)},jobs,optimize:false,viaPoints:vias}):{jobIds:[],legs:[],encodedPolyline:'',distanceMeters:0,durationSeconds:0,viaPoints:[]};
  if(JSON.stringify(road.jobIds)!==JSON.stringify(request.jobIds)||road.legs.length!==(jobs.length?jobs.length+1:0))throw error('Calculated route did not preserve the requested stop order.');
  const seqs=stableTransferSequences(request.jobIds,s.locked),[hour,minute]=String(s.settings.start_time).split(':').map(Number);let time=hour*3600+minute*60,distance=0,duration=0;
  const arrivals=request.jobIds.map((id,i)=>{const leg=road.legs[i];time+=leg.durationSeconds;distance+=leg.distanceMeters;duration+=leg.durationSeconds;const row={stopId:id,seq:seqs[i],status:'Pending',arrivalSecondsFromMidnight:Math.round(time),liveEtaSeconds:Math.round(time),travelSecondsFromPrev:leg.durationSeconds,distanceMetersFromPrev:leg.distanceMeters,cumulativeDistanceMeters:distance,cumulativeDurationSeconds:duration};time+=Number(s.settings.stop_duration_minutes)*60;const frozen=s.locked.get(id);if(frozen){const {owner,...record}=frozen;return{...row,...record};}return row;});
  if(jobs.length){const leg=road.legs[jobs.length];time+=leg.durationSeconds;arrivals.push({stopId:'__DEPOT__',seq:(seqs.at(-1)??0)+1,status:'Pending',arrivalSecondsFromMidnight:Math.round(time),liveEtaSeconds:Math.round(time),travelSecondsFromPrev:leg.durationSeconds,distanceMetersFromPrev:leg.distanceMeters,cumulativeDistanceMeters:distance+leg.distanceMeters,cumulativeDurationSeconds:duration+leg.durationSeconds});}
  results.push({...road,id:request.id,driverId:p.driver_id,version:p.route_version+1,stopArrivals:arrivals});
 }
 const token=randomUUID();await pool.query(`INSERT INTO mealcart_route_transfer_previews(id,actor_id,plan_date,snapshot_hash,request,result) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,[token,actorId,s.date,s.hash,JSON.stringify(input),JSON.stringify(results)]);
 // Bounded cleanup; completed tokens remain temporarily for idempotent response recovery.
 await pool.query("DELETE FROM mealcart_route_transfer_previews WHERE id IN (SELECT id FROM mealcart_route_transfer_previews WHERE expires_at<clock_timestamp()-interval '7 days' LIMIT 100)");
 return{token,routes:results,expiresInSeconds:600};
}
export async function commitRouteTransfer(token:string,actorId:string){
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
  const draft=(await c.query('SELECT *,expires_at>clock_timestamp() AS valid FROM mealcart_route_transfer_previews WHERE id=$1 AND actor_id=$2 FOR UPDATE',[token,actorId])).rows[0];
  if(!draft)throw error('Recalculate these routes before saving.');if(draft.applied_at){await c.query('COMMIT');return draft.receipt;}if(!draft.valid)throw error('This preview expired. Recalculate before saving.');
  const request=draft.request as TransferInput,ids=request.routes.map(r=>r.id);
  const drivers=(await c.query('SELECT driver_id,stop_arrivals FROM route_plans WHERE public_id=ANY($1::text[])',[ids])).rows;
  await c.query('SELECT public_id FROM drivers WHERE public_id=ANY($1::text[]) ORDER BY public_id FOR UPDATE',[drivers.map((d:any)=>d.driver_id)]);
  // Short commit-only lock blocks phantom assignments; Google calls already finished.
  await c.query('LOCK TABLE route_plans IN EXCLUSIVE MODE');
  const sourceIds=[...new Set([...drivers.flatMap((p:any)=>p.stop_arrivals.filter((s:any)=>s.stopId!=='__DEPOT__').map((s:any)=>s.stopId)),...request.routes.flatMap(r=>r.jobIds)])] as string[];
  for(const kind of ['J','C']){const numbers=sourceIds.filter(id=>id.startsWith('STP-'+kind)).map(id=>Number(id.slice(5)));if(numbers.length)await c.query(`SELECT id FROM ${kind==='J'?'jobs':'collections'} WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,[numbers]);}
  await c.query('SELECT id FROM mealcart_route_settings WHERE id=1 FOR SHARE');
  const s=await state(c,ids,request.routes.flatMap(r=>r.jobIds));if(s.hash!==draft.snapshot_hash)throw error('Routes, scans, settings or source orders changed after calculation. Reload and recalculate.');validate(request,s);
  const after=[];
  for(const result of draft.result){const row=(await c.query(`UPDATE route_plans SET job_ids=$2,stop_arrivals=$3::jsonb,legs=$4::jsonb,encoded_polyline=$5,distance_meters=$6,duration_seconds=$7,via_points=$8::jsonb,manual=true,route_version=route_version+1,updated_at=clock_timestamp() WHERE public_id=$1 RETURNING *,plan_date::text AS plan_date`,[result.id,result.jobIds,JSON.stringify(result.stopArrivals),JSON.stringify(result.legs),result.encodedPolyline,Math.round(result.distanceMeters),Math.round(result.durationSeconds),JSON.stringify(result.viaPoints??[])])).rows[0];after.push(toPublic(row));
   await c.query("UPDATE mealcart_route_execution SET next_eta_at=clock_timestamp()+interval '60 seconds',last_error='' WHERE plan_id=$1 AND plan_created_at=$2::timestamptz AND ended_at IS NULL",[result.id,s.plans.find((p:any)=>p.public_id===result.id).snapshot]);
  }
  const receipt={routes:after};await c.query('INSERT INTO mealcart_route_transfer_events(id,actor_id,plan_date,before_routes,after_routes) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[token,actorId,s.date,JSON.stringify(s.plans),JSON.stringify(after)]);
  await c.query('UPDATE mealcart_route_transfer_previews SET applied_at=clock_timestamp(),receipt=$2::jsonb WHERE id=$1',[token,JSON.stringify(receipt)]);await c.query('COMMIT');return receipt;
 }catch(e){await c.query('ROLLBACK');if(['55P03','40P01','40001'].includes(String((e as {code?:string}).code)))throw error('A driver or another planner is updating these routes. Recalculate and try again.');throw e;}finally{c.release();}
}

/** Release exactly the selected saved routes together; keep delivery proof and an audit snapshot. */
export async function deleteSelectedRoutes(input:{requestId:string;routes:{id:string;version:number}[]},actorId:string){
 const c=await pool.connect();const signature=JSON.stringify([...input.routes].sort((a,b)=>a.id.localeCompare(b.id)));
 const replay=async()=>{const event=(await c.query('SELECT * FROM mealcart_route_transfer_events WHERE id=$1',[input.requestId])).rows[0];if(!event)return null;const before=event.before_routes;if(event.actor_id!==actorId||before?.operation!=='delete'||before.signature!==signature)throw error('This deletion request belongs to a different action. Refresh and try again.');return{deletedIds:before.routes.map((p:any)=>p.public_id)};};
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");const existing=await replay();if(existing){await c.query('COMMIT');return existing;}
  const ids=input.routes.map(r=>r.id);const owners=(await c.query('SELECT driver_id FROM route_plans WHERE public_id=ANY($1::text[])',[ids])).rows;
  await c.query('SELECT public_id FROM drivers WHERE public_id=ANY($1::text[]) ORDER BY public_id FOR UPDATE',[owners.map((r:any)=>r.driver_id)]);
  await c.query('LOCK TABLE route_plans IN EXCLUSIVE MODE');const again=await replay();if(again){await c.query('COMMIT');return again;}
  const plans=(await c.query('SELECT *,plan_date::text AS plan_date FROM route_plans WHERE public_id=ANY($1::text[]) ORDER BY public_id',[ids])).rows;
  if(plans.length!==ids.length||new Set(plans.map((p:any)=>p.plan_date)).size!==1||plans.some((p:any)=>input.routes.find(r=>r.id===p.public_id)?.version!==p.route_version))throw error('One of the selected routes changed or was deleted. Refresh before deleting.');
  await c.query('INSERT INTO mealcart_route_transfer_events(id,actor_id,plan_date,before_routes,after_routes) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[input.requestId,actorId,plans[0].plan_date,JSON.stringify({operation:'delete',signature,routes:plans}),JSON.stringify([])]);
  await c.query('UPDATE mealcart_route_execution SET ended_at=clock_timestamp() WHERE plan_id=ANY($1::text[]) AND ended_at IS NULL',[ids]);
  await c.query('DELETE FROM route_plans WHERE public_id=ANY($1::text[])',[ids]);await c.query('COMMIT');return{deletedIds:plans.map((p:any)=>p.public_id)};
 }catch(e){await c.query('ROLLBACK');if(['55P03','40P01','40001'].includes(String((e as {code?:string}).code)))throw error('These routes are being updated. Refresh and try deleting again.');throw e;}finally{c.release();}
}

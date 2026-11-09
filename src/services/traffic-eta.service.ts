import {routeJob} from './job-notification-source.service.js';
import {pool} from '../db/pool.js';
import {env} from '../config/env.js';
import {messaging as cfg} from '../config/delivery-messaging.js';
import {localClock} from '../lib/delivery-events.js';
interface Point{lat:number;lng:number}
const point=(p:Point)=>({location:{latLng:{latitude:p.lat,longitude:p.lng}}});
function valid(p:Point){return p.lat!=null&&p.lng!=null&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng))&&Math.abs(Number(p.lat))<=90&&Math.abs(Number(p.lng))<=180;}
export async function refreshTrafficEtas(now=new Date()){
 const clock=localClock(now,cfg.DELIVERY_TIMEZONE);
 const executions=(await pool.query(`SELECT e.*,to_char(e.plan_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS plan_created_at,p.stop_arrivals,p.via_points,p.route_version,p.route_depot_id,p.plan_date::text AS date
 FROM mealcart_route_execution e JOIN route_plans p ON p.public_id=e.plan_id AND p.created_at::timestamptz=e.plan_created_at JOIN drivers d ON d.public_id=e.driver_id AND d.status='Active'
 WHERE e.ended_at IS NULL AND p.status='Planned' AND p.plan_date=$1 AND e.next_eta_at<=$2::timestamptz ORDER BY e.next_eta_at LIMIT 20`,[clock.date,now.toISOString()])).rows;
 for(const e of executions){
  await pool.query("UPDATE mealcart_route_execution SET next_eta_at=$3::timestamptz+($4*interval '1 second') WHERE plan_id=$1 AND plan_created_at=$2",[e.plan_id,e.plan_created_at,now.toISOString(),cfg.ETA_REFRESH_SECONDS]);
  try{
   const pending=e.stop_arrivals.filter((s:any)=>s.status==='Pending').sort((a:any,b:any)=>a.seq-b.seq);
   if(!pending.some((s:any)=>s.stopId!=='__DEPOT__')){await pool.query('UPDATE mealcart_route_execution SET ended_at=$3 WHERE plan_id=$1 AND plan_created_at=$2',[e.plan_id,e.plan_created_at,now.toISOString()]);continue;}
   const gps=(await pool.query(`SELECT lat,lng FROM mealcart_driver_locations WHERE driver_id=$1 AND tracking_enabled=true AND accuracy<=100 AND captured_at>$2::timestamptz-interval '90 seconds' AND received_at>$2::timestamptz-interval '90 seconds'`,[e.driver_id,now.toISOString()])).rows[0];
   if(!gps)throw new Error('Waiting for fresh driver GPS; live ETA is stale');
   const settings=(await pool.query('SELECT stop_duration_minutes FROM mealcart_route_settings WHERE id=1')).rows[0];if(!settings)throw new Error('Route settings unavailable');
   const depot=(await pool.query('SELECT p.lat,p.lng FROM drivers d JOIN depots p ON p.public_id=COALESCE($2::text,d.depot_id) WHERE d.public_id=$1',[e.driver_id,e.route_depot_id])).rows[0];
   const waypoints:{id:string|null;position:Point;via:boolean}[]=[];
   for(const s of pending){
    for(const via of e.via_points??[])if(via.beforeJobId===(s.stopId==='__DEPOT__'?null:s.stopId)){if(!valid(via.position))throw new Error('A saved via point has invalid coordinates');waypoints.push({id:null,position:via.position,via:true});}
    let dest:any;if(s.stopId==='__DEPOT__')dest=depot;else{const collection=/^STP-C([1-9]\d*)$/.exec(s.stopId);if(collection)dest=(await pool.query('SELECT latitude AS lat,longitude AS lng FROM collections WHERE id=$1',[collection[1]])).rows[0];else{const job=await routeJob(s);if(!job)throw new Error('No matching delivery job');dest=(await pool.query('SELECT latitude AS lat,longitude AS lng FROM jobs WHERE do_number=$1',[job.do_number])).rows[0];}}
    if(!dest||!valid(dest))throw new Error('A remaining stop has no coordinates');waypoints.push({id:s.stopId,position:dest,via:false});
   }
   let origin:Point={lat:Number(gps.lat),lng:Number(gps.lng)},elapsed=0;
   const arrivals=new Map<string,number>();let offset=0;
   while(offset<waypoints.length){
    // At most 25 intermediates. End each chunk at a stopover (not a via).
    let end=Math.min(offset+26,waypoints.length);while(end>offset&&waypoints[end-1].via)end--;if(end<=offset)throw new Error('Too many consecutive road via points');
    const chunk=waypoints.slice(offset,end),last=chunk.at(-1)!;
    const budget=await pool.query(`UPDATE mealcart_route_execution SET request_count=CASE WHEN request_day=$3::date THEN request_count+1 ELSE 1 END,request_day=$3::date WHERE plan_id=$1 AND plan_created_at=$2 AND (request_day IS DISTINCT FROM $3::date OR request_count<$4) RETURNING request_count`,[e.plan_id,e.plan_created_at,clock.date,cfg.ETA_MAX_REQUESTS_PER_ROUTE_DAY]);
    if(!budget.rowCount)throw new Error('Daily live ETA request cap reached');
    const res=await fetch('https://routes.googleapis.com/directions/v2:computeRoutes',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':env.GOOGLE_MAPS_API_KEY,'X-Goog-FieldMask':'routes.legs.duration'},body:JSON.stringify({origin:point(origin),destination:point(last.position),intermediates:chunk.slice(0,-1).map(w=>({...point(w.position),via:w.via})),travelMode:'DRIVE',routingPreference:'TRAFFIC_AWARE',optimizeWaypointOrder:false,departureTime:new Date(now.getTime()+elapsed*1000).toISOString()}),signal:AbortSignal.timeout(20000)});
    if(!res.ok)throw new Error(`Google traffic routing rejected request (HTTP ${res.status})`);
    const data:any=await res.json(),legs=data.routes?.[0]?.legs,stops=chunk.filter(w=>!w.via);
    if(!Array.isArray(legs)||legs.length!==stops.length)throw new Error('Google traffic leg count did not match remaining stops');
    for(let i=0;i<stops.length;i++){const str=String(legs[i].duration??'');if(!/^\d+(\.\d+)?s$/.test(str))throw new Error('Google returned an invalid travel time');elapsed+=Math.ceil(parseFloat(str));arrivals.set(stops[i].id!,clock.seconds+elapsed);if(stops[i].id!=='__DEPOT__')elapsed+=Number(settings.stop_duration_minutes)*60;}
    origin=last.position;offset=end;
   }
   const updated=e.stop_arrivals.map((s:any)=>arrivals.has(s.stopId)?{...s,liveEtaSeconds:arrivals.get(s.stopId),liveEtaUpdatedAt:now.toISOString(),liveEtaSource:'Google traffic'}:s);
   // No plan version bump for timing alone; immutable stop identities and proof remain valid.
   const result=await pool.query(`UPDATE route_plans p SET stop_arrivals=$4::jsonb,updated_at=clock_timestamp() WHERE public_id=$1 AND created_at::timestamptz=$2 AND route_version=$3 AND stop_arrivals=$5::jsonb AND EXISTS(SELECT 1 FROM mealcart_route_execution e WHERE e.plan_id=p.public_id AND e.plan_created_at=p.created_at::timestamptz AND e.ended_at IS NULL)`,[e.plan_id,e.plan_created_at,e.route_version,JSON.stringify(updated),JSON.stringify(e.stop_arrivals)]);
   if(!result.rowCount)throw new Error('Route progress changed during traffic calculation; next tick will retry');
   await pool.query("UPDATE mealcart_route_execution SET eta_updated_at=$3,last_error='' WHERE plan_id=$1 AND plan_created_at=$2",[e.plan_id,e.plan_created_at,now.toISOString()]);
  }catch(error){await pool.query('UPDATE mealcart_route_execution SET last_error=$3 WHERE plan_id=$1 AND plan_created_at=$2',[e.plan_id,e.plan_created_at,(error as Error).message]);}
 }
}

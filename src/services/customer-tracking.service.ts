import {createHash,createHmac,randomUUID} from 'node:crypto';
import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
import {customerTracking as config} from '../config/customer-tracking.js';
import {messaging} from '../config/delivery-messaging.js';
import {localClock} from '../lib/delivery-events.js';
import {routeNotificationSource,type NotificationSource} from './job-notification-source.service.js';

interface TrackingOrder {
 source: NotificationSource;
 id: number;
 reference: string;
 customerId: string;
 recipientPhone: string;
 recipientEmail: string;
 date: string;
}
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const tokenHash = (token:string) => createHash('sha256').update(token).digest('hex');
const unavailable = () => new ApiError(404,'TRACKING_UNAVAILABLE','This tracking link is unavailable or has expired.');
function tokenFor(id:string) {
 return createHmac('sha256',config.TRACKING_LINK_SECRET).update('mealcart-customer-tracking-v1:'+id).digest('base64url');
}
function tableFor(source:NotificationSource) {
 return source === 'collections' ? 'collections' : 'jobs';
}
function recipientHash(phone:unknown,email:unknown) {
 return createHash('sha256').update(JSON.stringify([
  String(phone??'').trim().replace(/[\s()-]/g,''),
  String(email??'').trim().toLowerCase(),
 ])).digest('hex');
}
function sameOrder(row:any,order:TrackingOrder) {
 return row.do_number === order.reference && String(row.customer_id) === order.customerId
  && row.recipient_hash===recipientHash(order.recipientPhone,order.recipientEmail);
}

/** Return one reusable link per order/date. Only its hash is stored in the database. */
export async function getOrCreateTrackingLink(order:TrackingOrder,now=new Date()) {
 if(config.TRACKING_LINK_SECRET.length < 32)throw new ApiError(503,'TRACKING_NOT_CONFIGURED','Set the same TRACKING_LINK_SECRET (at least 32 characters) on the API and notification worker.');
 const id=randomUUID(),candidateToken=tokenFor(id);
 const args=[id,order.source,order.id,order.reference,order.customerId,order.date,tokenHash(candidateToken),config.TRACKING_LINK_VALID_DAYS,messaging.DELIVERY_TIMEZONE,recipientHash(order.recipientPhone,order.recipientEmail),now.toISOString()];
 // Updating the identity when the source owner/reference changes invalidates the previous link.
 let row=(await pool.query(`INSERT INTO mealcart_customer_tracking_links
  (id,source_kind,job_id,do_number,customer_id,delivery_date,token_hash,expires_at,recipient_hash)
  VALUES($1,$2,$3,$4,$5,$6,$7,GREATEST((($6::date+($8::integer+1))::timestamp AT TIME ZONE $9),$11::timestamptz+interval '24 hours'),$10)
  ON CONFLICT(source_kind,job_id,delivery_date) DO UPDATE SET
   id=EXCLUDED.id,do_number=EXCLUDED.do_number,customer_id=EXCLUDED.customer_id,
   token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,recipient_hash=EXCLUDED.recipient_hash,created_at=clock_timestamp()
  WHERE mealcart_customer_tracking_links.revoked_at IS NULL AND
   (mealcart_customer_tracking_links.do_number IS DISTINCT FROM EXCLUDED.do_number
    OR mealcart_customer_tracking_links.customer_id IS DISTINCT FROM EXCLUDED.customer_id
    OR mealcart_customer_tracking_links.recipient_hash IS DISTINCT FROM EXCLUDED.recipient_hash
    OR mealcart_customer_tracking_links.expires_at<=$11::timestamptz)
  RETURNING *`,args)).rows[0];
 if(!row)row=(await pool.query('SELECT * FROM mealcart_customer_tracking_links WHERE source_kind=$1 AND job_id=$2 AND delivery_date=$3',[order.source,order.id,order.date])).rows[0];
 if(!row||!sameOrder(row,order)||row.revoked_at||new Date(row.expires_at).getTime()<=now.getTime())throw unavailable();
 const token=tokenFor(row.id),hash=tokenHash(token);
 if(row.token_hash!==hash){
  // A deliberate secret rotation invalidates previously issued URLs on the next send.
  const changed=await pool.query('UPDATE mealcart_customer_tracking_links SET token_hash=$2 WHERE id=$1 AND token_hash=$3 AND revoked_at IS NULL RETURNING id',[row.id,hash,row.token_hash]);
  if(!changed.rowCount)throw unavailable();
 }
 const url=new URL(config.TRACKING_PUBLIC_URL);
 url.hash='token='+token;
 return url.toString();
}
function coordinates(lat:unknown,lng:unknown) {
 if(lat==null||lng==null||lat===''||lng==='')return null;
 const point={lat:Number(lat),lng:Number(lng)};
 return Number.isFinite(point.lat)&&Number.isFinite(point.lng)&&Math.abs(point.lat)<=90&&Math.abs(point.lng)<=180 ? point : null;
}
function timestamp(value:unknown) {
 if(value==null)return null;
 const time=new Date(String(value)).getTime();
 return Number.isFinite(time)?new Date(time).toISOString():null;
}
function ageMs(value:unknown,now:Date) {
 const iso=timestamp(value);
 return iso==null?Infinity:now.getTime()-Date.parse(iso);
}
function arrivalTime(value:unknown) {
 if(value==null||value==='')return null;
 const seconds=Number(value);
 if(!Number.isFinite(seconds)||seconds<0)return null;
 return String(Math.floor(seconds/3600)%24).padStart(2,'0')+':'+String(Math.floor(seconds/60)%60).padStart(2,'0');
}

/** Expose only this order and its currently assigned driver's eligible GPS point. */
export async function publicOrderTracking(token:string,now=new Date()) {
 if(!tokenPattern.test(token))throw unavailable();
 const link=(await pool.query(`SELECT *,delivery_date::text AS date FROM mealcart_customer_tracking_links
  WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>$2::timestamptz`,[tokenHash(token),now.toISOString()])).rows[0];
 if(!link||!['jobs','collections'].includes(link.source_kind))throw unavailable();
 const source=link.source_kind as NotificationSource,table=tableFor(source);
 const sources=(await pool.query(`SELECT to_jsonb(j) AS record FROM ${table} j
  WHERE id=$1 AND do_number=$2 AND user_id::text=$3 AND scheduled_date=$4`,
  [link.job_id,link.do_number,link.customer_id,link.date])).rows;
 if(sources.length!==1)throw unavailable();
 const order=sources[0].record;
 const phone=String(order.recipient_phone??'').trim()||String(order.recipient_phon??'').trim();
 if(link.recipient_hash!==recipientHash(phone,order.recipient_email))throw unavailable();
 // A reused/ambiguous delivery reference cannot expose another order's route.
 if(source==='jobs'){
  const references=(await pool.query('SELECT id FROM jobs WHERE do_number=$1 LIMIT 2',[link.do_number])).rows;
  if(references.length!==1||references[0].id!==link.job_id)throw unavailable();
 }
 const base={
  reference:link.do_number,
  serviceType:source==='collections'?'Collection':'Delivery',
  scheduledDate:link.date,
  timeZone:messaging.DELIVERY_TIMEZONE,
  destination:coordinates(order.latitude,order.longitude),
  status:'scheduled',
  locationState:'not_started',
  locationUpdatedAt:null as string|null,
  driver:null as null|{lat:number;lng:number;accuracy:number;capturedAt:string;moving:boolean},
  eta:null as null|{time:string;kind:'live'|'planned';updatedAt:string|null},
  terminal:false,
  refreshAfterSeconds:15,
 };
 const events=(await pool.query(`SELECT 'completed' AS status FROM mealcart_completed_delivery_events
   WHERE source_kind=$1 AND job_id=$2 AND delivery_date=$3 AND do_number=$4
  UNION ALL SELECT 'failed' AS status FROM mealcart_delivery_failures
   WHERE source_kind=$1 AND job_id=$2 AND delivery_date=$3 AND (do_number=$4 OR (do_number IS NULL AND source_kind='jobs'))
  LIMIT 2`,[source,link.job_id,link.date,link.do_number])).rows;
 const orderStatus=String(order.status??'').toLowerCase();
 if(['completed','failed','cancelled','canceled'].includes(orderStatus)||events.length){
  const status=['cancelled','canceled'].includes(orderStatus)?'cancelled':
   events.some(event=>event.status==='completed')||orderStatus==='completed'?'completed':'failed';
  return {...base,status,terminal:true,locationState:'hidden'};
 }
 const stops=(await pool.query(`SELECT p.driver_id,p.created_at,p.public_id,s.value AS stop,
   e.started_at,e.ended_at,e.eta_updated_at,d.status AS driver_status,
   e.driver_id AS execution_driver_id
  FROM route_plans p CROSS JOIN LATERAL jsonb_array_elements(p.stop_arrivals) s(value)
  LEFT JOIN mealcart_route_execution e ON e.plan_id=p.public_id AND e.plan_created_at=p.created_at::timestamptz
  LEFT JOIN drivers d ON d.public_id=p.driver_id
  WHERE p.plan_date=$1 AND p.status='Planned' AND
   (s.value->>'stopId'=$3 OR ($4='jobs' AND s.value->>'stopId' NOT LIKE 'STP-C%' AND
    (s.value->>'stopId'=$2 OR s.value->>'do_number'=$2 OR s.value->>'doNumber'=$2 OR s.value->>'orderRef'=$2)))`,
  [link.date,link.do_number,`STP-${source==='jobs'?'J':'C'}${link.job_id}`,source])).rows;
 if(stops.length!==1)return base;
 const route=stops[0],resolved=await routeNotificationSource(route.stop).catch(()=>null);
 if(resolved?.kind!==source||resolved.id!==link.job_id)return base;
 const stopStatus=String(route.stop.status??'').toLowerCase();
 if(['completed','failed','cancelled','canceled','skipped'].includes(stopStatus)){
  return {...base,status:stopStatus==='canceled'?'cancelled':stopStatus,terminal:true,locationState:'hidden'};
 }
 const today=localClock(now,messaging.DELIVERY_TIMEZONE).date;
 const active=link.date===today&&route.started_at&&!route.ended_at&&route.execution_driver_id===route.driver_id
  &&String(route.driver_status).toLowerCase()==='active'&&ageMs(route.started_at,now)>=0;
 const liveTime=active&&ageMs(route.eta_updated_at,now)>=0&&ageMs(route.eta_updated_at,now)<=Math.max(messaging.ETA_REFRESH_SECONDS*2,600)*1000?arrivalTime(route.stop.liveEtaSeconds):null;
 const etaTime=liveTime??arrivalTime(route.stop.arrivalSecondsFromMidnight);
 if(etaTime)base.eta={time:etaTime,kind:liveTime?'live':'planned',updatedAt:liveTime?timestamp(route.eta_updated_at):null};
 if(!active)return base;
 base.status='on_the_way';
 const location=(await pool.query(`SELECT l.lat,l.lng,l.accuracy,l.speed,l.captured_at,l.received_at,l.tracking_enabled
  FROM mealcart_driver_locations l JOIN mealcart_driver_tracking_sessions s ON s.id=l.session_id AND s.driver_id=l.driver_id
  WHERE l.driver_id=$1 AND s.ended_at IS NULL`,[route.driver_id])).rows[0];
 if(!location?.tracking_enabled)return {...base,locationState:'not_sharing'};
 base.locationUpdatedAt=timestamp(location.captured_at);
 const point=coordinates(location.lat,location.lng),capturedAge=ageMs(location.captured_at,now),receivedAge=ageMs(location.received_at,now);
 const accuracy=location.accuracy==null?Infinity:Number(location.accuracy);
 const fresh=point&&capturedAge>=-30000&&capturedAge<=120000&&receivedAge>=-30000&&receivedAge<=120000
  &&Number.isFinite(accuracy)&&accuracy>=0&&accuracy<=100;
 if(!fresh)return {...base,locationState:'unavailable'};
 return {...base,locationState:'live',driver:{...point!,accuracy,capturedAt:base.locationUpdatedAt!,moving:Number(location.speed??0)>=0.8}};
}

import { pool } from '../db/pool.js';
import { ApiError } from '../types/api.types.js';
import { toPublic, type RoutePlanRow } from '../models/route-plan.model.js';

/** Fetch only source records explicitly present on this driver's owned plan. No geocoding side effects. */
async function attachStops(row:RoutePlanRow){
 const jobs:number[]=[],collections:number[]=[];
 for(const id of row.job_ids){const m=/^STP-([JC])([1-9]\d*)$/.exec(id);if(m&&Number.isSafeInteger(Number(m[2]))&&Number(m[2])<=2147483647)(m[1]==='J'?jobs:collections).push(Number(m[2]));}
 const jobRows=jobs.length?(await pool.query(`SELECT id,do_number AS "orderRef",customer_name AS "customerName",phone,delivery_address AS address,postcode,city,state,latitude AS lat,longitude AS lng,special_instructions AS notes FROM jobs WHERE id=ANY($1::int[])`,[jobs])).rows:[];
 const collectionRows=collections.length?(await pool.query(`SELECT id,do_number AS "orderRef",recipient_name AS "customerName",recipient_phone AS phone,collection_address AS address,postcode,city,state,latitude AS lat,longitude AS lng,special_instructions AS notes,time_window AS "window" FROM collections WHERE id=ANY($1::int[])`,[collections])).rows:[];
 const details=new Map<string,any>();
 for(const r of jobRows)details.set(`STP-J${r.id}`,{...r,jobType:'Delivery'});
 for(const r of collectionRows)details.set(`STP-C${r.id}`,{...r,jobType:'Collection'});
 const plan=toPublic(row);
 return{...plan,planDate:String(row.plan_date).slice(0,10),stops:row.stop_arrivals.filter(s=>s.stopId!=='__DEPOT__').sort((a,b)=>a.seq-b.seq).map(s=>{
  const detail=details.get(s.stopId);
  return{...s,orderRef:detail?.orderRef??s.stopId,customerName:detail?.customerName??'Order unavailable',phone:detail?.phone??'',address:detail?.address??'',postcode:detail?.postcode??'',city:detail?.city??'',state:detail?.state??'',notes:detail?.notes??'',window:detail?.window??'',jobType:detail?.jobType??'Delivery',lat:detail?.lat==null?null:Number(detail.lat),lng:detail?.lng==null?null:Number(detail.lng),available:!!detail};
 })};
}
export async function listDriverRoutes(driverId:string,date:string){
 const rows=(await pool.query<RoutePlanRow>(`SELECT *,plan_date::text AS plan_date FROM route_plans WHERE driver_id=$1 AND plan_date=$2 AND status='Planned' ORDER BY public_id`,[driverId,date])).rows;
 return rows.map(row=>({id:row.public_id,planDate:date,distanceMeters:row.distance_meters,durationSeconds:row.duration_seconds,stopCount:row.job_ids.length,completed:row.stop_arrivals.filter(s=>s.stopId!=='__DEPOT__'&&s.status==='Completed').length}));
}
export async function getDriverRoute(driverId:string,id:string){
 const row=(await pool.query<RoutePlanRow>("SELECT *,plan_date::text AS plan_date FROM route_plans WHERE public_id=$1 AND driver_id=$2 AND status='Planned'",[id,driverId])).rows[0];
 if(!row)throw new ApiError(404,'ROUTE_NOT_FOUND','This route is not available to your driver account.');
 return attachStops(row);
}
export async function completeDriverStop(driverId:string,planId:string,seq:number,stopId:string,version:number){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const row=(await c.query<RoutePlanRow>("SELECT *,plan_date::text AS plan_date FROM route_plans WHERE public_id=$1 AND driver_id=$2 AND status='Planned' FOR UPDATE",[planId,driverId])).rows[0];
  if(!row)throw new ApiError(404,'ROUTE_NOT_FOUND','This route is not available to your driver account.');
  const index=row.stop_arrivals.findIndex(s=>s.seq===seq&&s.stopId===stopId&&s.stopId!=='__DEPOT__');
  if(index<0||!row.job_ids.includes(stopId))throw new ApiError(404,'STOP_NOT_FOUND','This order is not on the assigned route.');
  const stop=row.stop_arrivals[index];
  if(stop.status!=='Completed'){
   if(row.route_version!==version)throw new ApiError(409,'ROUTE_CHANGED','The route changed. Reload the order before completing it.');
   if(stop.status!=='Pending')throw new ApiError(409,'STOP_NOT_PENDING','Only a pending delivery or collection can be completed.');
   const m=/^STP-([JC])([1-9]\d*)$/.exec(stopId);
   const source=m?(await c.query(`SELECT id FROM ${m[1]==='J'?'jobs':'collections'} WHERE id=$1`,[m[2]])).rows[0]:null;
   if(!source)throw new ApiError(409,'ORDER_UNAVAILABLE','The source order is no longer available. Contact the office.');
   const completed={...stop,status:'Completed',completedAt:new Date().toISOString(),completedByDriverId:driverId};
   await c.query(`UPDATE route_plans SET stop_arrivals=jsonb_set(stop_arrivals,$1::text[],$2::jsonb,false),route_version=route_version+1,updated_at=NOW() WHERE public_id=$3`,[`{${index}}`,JSON.stringify(completed),planId]);
  }
  await c.query('COMMIT');
 }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
 return getDriverRoute(driverId,planId);
}

import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
import {repairRouteReceipt} from './completion-reconciliation.service.js';
export async function assignedRouteProofDetails(id:string){
 const c=await pool.connect();try{
  await c.query('BEGIN');const plan=(await c.query(`SELECT *,to_char(created_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM route_plans WHERE public_id=$1 FOR UPDATE`,[id])).rows[0];
  if(!plan)throw new ApiError(404,'ROUTE_NOT_FOUND','This route no longer exists.');
  const stops=[];
  for(let index=0;index<plan.stop_arrivals.length;index++){
   const stop=plan.stop_arrivals[index],match=/^STP-([JC])([1-9]\d*)$/.exec(stop.stopId);if(!match)continue;
   const table=match[1]==='J'?'jobs':'collections';const source=(await c.query(`SELECT to_jsonb(s) AS value FROM ${table} s WHERE id=$1`,[match[2]])).rows;
   if(source.length>1)throw new ApiError(409,'AMBIGUOUS_SOURCE','Duplicate source order IDs require office review.');
   const job=source[0]?.value;let receipt:any=null;
   if(job&&table==='jobs')receipt=await repairRouteReceipt(c,plan,stop,index,job);
   const driver=receipt?(await c.query('SELECT name FROM drivers WHERE public_id=$1',[receipt.driver_id])).rows[0]:null;
   stops.push({...stop,available:!!job,orderRef:job?.do_number??stop.stopId,customerName:job?.recipient_name||job?.customer_name||'Order unavailable',phone:job?.recipient_phon||job?.recipient_phone||job?.phone||'',address:job?.delivery_address||job?.collection_address||job?.address||'',postcode:job?.postcode||'',city:job?.city||'',state:job?.state||'',notes:job?.special_instructions||'',jobType:table==='jobs'?'Delivery':'Collection',jobStatus:job?.status??'',completion:receipt?{id:receipt.id,completedAt:receipt.completed_at,driverId:receipt.driver_id,driverName:driver?.name??receipt.driver_id,photos:receipt.photos,signatureUrl:receipt.signature_url,barcodes:receipt.expected_barcodes}:null});
  }
  await c.query('COMMIT');return {id:plan.public_id,version:plan.route_version,stops};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

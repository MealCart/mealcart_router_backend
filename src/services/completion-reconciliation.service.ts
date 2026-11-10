import type {PoolClient} from 'pg';
import {ApiError} from '../types/api.types.js';
/** Call with the plan row locked. A matching durable receipt is the completion authority. */
export async function repairRouteReceipt(c:PoolClient,plan:any,stop:any,index:number,job:any){
 const receipts=(await c.query(`SELECT * FROM mealcart_delivery_completions WHERE plan_id=$1 AND plan_created_at=$2::timestamptz AND stop_seq=$3 AND job_id=$4 AND do_number=$5`,[plan.public_id,plan.created_at,stop.seq,job.id,String(job.do_number)])).rows;
 if(receipts.length>1)throw new ApiError(409,'AMBIGUOUS_RECEIPT','Multiple receipts match this stop. Office review is required.');
 const receipt=receipts[0];if(!receipt)return null;
 if(!Array.isArray(receipt.photos)||!receipt.photos.length||!receipt.signature_url)throw new ApiError(409,'INCOMPLETE_RECEIPT','The stored completion is missing proof. Keep local evidence for office review.');
 if(!['Pending','Completed'].includes(stop.status))throw new ApiError(409,'STOP_STATE_CONFLICT','Stored proof conflicts with this stop status. Office review is required.');
 if(stop.status!=='Completed'||stop.proof?.completionId!==receipt.id){
  const completed={...stop,status:'Completed',completedAt:new Date(receipt.completed_at).toISOString(),completedByDriverId:receipt.driver_id,proof:{completionId:receipt.id,photos:receipt.photos,signatureUrl:receipt.signature_url,parcelCount:Array.isArray(receipt.expected_barcodes)?receipt.expected_barcodes.length:0}};
  await c.query(`UPDATE route_plans SET stop_arrivals=jsonb_set(stop_arrivals,$1::text[],$2::jsonb,false),completion_photos=jsonb_set(COALESCE(completion_photos,'{}'::jsonb),$3::text[],$4::jsonb,true),completion_signatures=jsonb_set(COALESCE(completion_signatures,'{}'::jsonb),$3::text[],$5::jsonb,true),route_version=route_version+1,updated_at=clock_timestamp() WHERE public_id=$6 AND created_at::timestamptz=$7::timestamptz`,[[String(index)],JSON.stringify(completed),[stop.stopId],JSON.stringify(receipt.photos),JSON.stringify(receipt.signature_url),plan.public_id,plan.created_at]);
  Object.assign(stop,completed);plan.route_version++;
 }
 return receipt;
}
/** Status-only completion can receive its missing proof, but never replace saved proof. */
export async function canAttachMissingProof(c:PoolClient,job:any){
 const status=String(job.status).toLowerCase();if(!['pending','completed'].includes(status))return false;
 const all=(await c.query('SELECT to_jsonb(j) AS value FROM jobs j WHERE id=$1',[job.id])).rows;
 if(all.length!==1)throw new ApiError(409,'AMBIGUOUS_JOB','More than one job row has this ID. Office review is required.');
 const value=all[0].value;
 if(value.completion_signature_url||Array.isArray(value.completion_photos)&&value.completion_photos.length||value.completion_recorded_at)return false;
 return !(await c.query('SELECT id FROM mealcart_delivery_completions WHERE job_id=$1 AND do_number=$2 LIMIT 1',[job.id,String(job.do_number)])).rows.length;
}

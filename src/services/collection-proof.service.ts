import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
import {saveEvidence,removeMedia,type StoredMedia} from './proof-storage.service.js';
import type {ProofInput} from '../validators/delivery-proof.validator.js';
import type {PoolClient} from 'pg';
async function context(c:PoolClient,driver:string,id:string,seq:number){
 const plan=(await c.query(`SELECT *,to_char(created_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS snapshot FROM route_plans WHERE public_id=$1 AND driver_id=$2 AND status='Planned' FOR UPDATE`,[id,driver])).rows[0];
 if(!plan)throw new ApiError(404,'ROUTE_NOT_FOUND','This route is not assigned to your account.');
 const index=plan.stop_arrivals.findIndex((s:any)=>s.seq===seq),stop=plan.stop_arrivals[index];
 const match=stop&&/^STP-C([1-9]\d*)$/.exec(stop.stopId);
 if(!match)throw new ApiError(400,'COLLECTION_REQUIRED','This is not a collection stop.');
 const job=(await c.query('SELECT id,do_number,status FROM collections WHERE id=$1 FOR UPDATE',[match[1]])).rows[0];
 if(!job)throw new ApiError(404,'ORDER_UNAVAILABLE','The collection is unavailable.');
 return {plan,stop,index,job};
}
export async function collectionProofState(driver:string,id:string,seq:number){
 const c=await pool.connect();try{await c.query('BEGIN');const {plan,stop,job}=await context(c,driver,id,seq);
 const receipt=(await c.query('SELECT * FROM mealcart_collection_completions WHERE plan_id=$1 AND plan_created_at=$2 AND stop_seq=$3 AND collection_id=$4 AND do_number=$5',[id,plan.snapshot,seq,job.id,job.do_number])).rows[0];
 const result={stopId:stop.stopId,doNumber:String(job.do_number),planCreatedAt:plan.snapshot,version:plan.route_version,status:stop.status,configurationError:'',barcodes:[],scannedCount:0,totalCount:0,proofRetryAllowed:stop.status==='Pending'&&!receipt,proof:receipt?{completionId:receipt.id,photos:receipt.photos,signatureUrl:receipt.signature_url,completedAt:receipt.completed_at}:null};
 await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function completeCollectionWithProof(driver:string,id:string,seq:number,input:ProofInput,photos:Buffer[]){
 const c=await pool.connect();let files:StoredMedia[]=[],committed=false;
 try{await c.query('BEGIN');const {plan,stop,index,job}=await context(c,driver,id,seq);
 if(input.stopId!==stop.stopId||input.doNumber!==String(job.do_number))throw new ApiError(409,'ORDER_CHANGED','The collection changed. Keep your evidence and download again.');
 if(input.offline&&input.offline.planCreatedAt!==plan.snapshot)throw new ApiError(409,'OFFLINE_ROUTE_REPLACED','The route was replaced. Keep your evidence for office review.');
 const receipt=(await c.query(`SELECT *,to_char(plan_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS snapshot FROM mealcart_collection_completions WHERE id=$1`,[input.requestId])).rows[0];
 if(receipt){if(receipt.driver_id!==driver||receipt.plan_id!==id||receipt.snapshot!==plan.snapshot||receipt.stop_seq!==seq||receipt.collection_id!==job.id||receipt.do_number!==input.doNumber)throw new ApiError(409,'REQUEST_CONFLICT','This receipt belongs to another order.');await c.query('COMMIT');committed=true;}
 else{
 if(stop.status!=='Pending'||String(job.status).toLowerCase()!=='pending')throw new ApiError(409,'STOP_NOT_PENDING','This collection is no longer pending. Keep your evidence for office review.');
 if(!input.offline&&input.version!==plan.route_version)throw new ApiError(409,'ROUTE_CHANGED','Reload the changed route before completing.');
 if(input.offline){const at=Date.parse(input.offline.completedAt);if(at>Date.now()+300000||at<Date.parse(plan.snapshot)-86400000)throw new ApiError(409,'OFFLINE_CLOCK_INVALID','Check the phone clock; evidence is retained.');if(input.offline.expectedBarcodes.length||input.offline.scans.length)throw new ApiError(400,'COLLECTION_SCANS_NOT_ALLOWED','Collection proof does not accept parcel scans.');}
 if((await c.query('SELECT id FROM mealcart_collection_completions WHERE collection_id=$1 AND do_number=$2 LIMIT 1',[job.id,input.doNumber])).rows.length)throw new ApiError(409,'ALREADY_COMPLETED','Collection proof already exists. Office review is required.');
 files=await saveEvidence(photos,input.signature);const links=files.filter(f=>f.kind==='photo').map(f=>f.url),signature=files.find(f=>f.kind==='signature')!.url;
 const receipt=(await c.query('INSERT INTO mealcart_collection_completions(id,plan_id,plan_created_at,stop_seq,collection_id,do_number,driver_id,photos,signature_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING completed_at',[input.requestId,id,plan.snapshot,seq,job.id,input.doNumber,driver,JSON.stringify(links),signature])).rows[0];
 for(const f of files)await c.query('INSERT INTO mealcart_collection_media(id,completion_id,kind,filename,mime_type) VALUES($1,$2,$3,$4,$5)',[f.id,input.requestId,f.kind,f.filename,f.mime]);
 await c.query("UPDATE collections SET status='completed' WHERE id=$1",[job.id]);
 const completed={...stop,status:'Completed',completedAt:new Date(receipt.completed_at).toISOString(),completedByDriverId:driver,proof:{completionId:input.requestId,photos:links,signatureUrl:signature},...(input.offline?{offlineRecordedAt:input.offline.completedAt}: {})};
 await c.query(`UPDATE route_plans SET stop_arrivals=jsonb_set(stop_arrivals,$1::text[],$2::jsonb,false),completion_photos=jsonb_set(COALESCE(completion_photos,'{}'::jsonb),$3::text[],$4::jsonb,true),completion_signatures=jsonb_set(COALESCE(completion_signatures,'{}'::jsonb),$3::text[],$5::jsonb,true),route_version=route_version+1,updated_at=NOW() WHERE public_id=$6`,[[String(index)],JSON.stringify(completed),[stop.stopId],JSON.stringify(links),JSON.stringify(signature),id]);
 await c.query(`INSERT INTO mealcart_completed_delivery_events(completion_id,plan_id,plan_created_at,stop_seq,job_id,do_number,delivery_date,driver_id,driver_name,completed_at,source_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8::text,COALESCE((SELECT name FROM drivers WHERE public_id=$8::text),'Mealcart driver'),$9,'collections')`,[input.requestId,id,plan.snapshot,seq,job.id,input.doNumber,plan.plan_date,driver,input.offline?.completedAt??receipt.completed_at]);
 await c.query('COMMIT');committed=true;
 }
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(files.length&&!committed){try{const check=await c.query('SELECT id FROM mealcart_collection_completions WHERE id=$1',[input.requestId]);if(!check.rows.length)await removeMedia(files);}catch{/* uncertain commit: retain files */}}throw e;}finally{c.release();}
 return collectionProofState(driver,id,seq);
}

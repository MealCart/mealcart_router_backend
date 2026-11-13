// Completion consistency repair v1
import {collectionProofState,completeCollectionWithProof} from './collection-proof.service.js';
import {repairRouteReceipt,canAttachMissingProof} from './completion-reconciliation.service.js';
import type {PoolClient} from 'pg';
import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
import {barcodeKey,expectedBarcodes,type ProofInput} from '../validators/delivery-proof.validator.js';
import {saveEvidence,removeMedia,type StoredMedia} from './proof-storage.service.js';
async function transaction<T>(run:(c:PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const out=await run(c);await c.query('COMMIT');return out;}catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}}
async function context(c:PoolClient,driverId:string,planId:string,seq:number,lock=false){
 const plan=(await c.query(`SELECT *,to_char(created_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM route_plans WHERE public_id=$1 AND driver_id=$2 AND status='Planned'${lock?' FOR UPDATE':''}`,[planId,driverId])).rows[0];
 if(!plan)throw new ApiError(404,'ROUTE_NOT_FOUND','This route is not assigned to your account.');
 const index=plan.stop_arrivals.findIndex((s:any)=>s.seq===seq);const stop=plan.stop_arrivals[index];
 const match=stop&&/^STP-J([1-9]\d*)$/.exec(stop.stopId);
 if(!match)throw new ApiError(400,'DELIVERY_REQUIRED','Parcel proof is available for delivery jobs only.');
 const job=(await c.query(`SELECT id,do_number,barcodes,status FROM jobs WHERE id=$1${lock?' FOR UPDATE':''}`,[match[1]])).rows[0];
 if(!job)throw new ApiError(404,'JOB_NOT_FOUND','The assigned job is unavailable. Contact the office.');
 return{plan,stop,index,job};
}
function codes(job:any){try{return expectedBarcodes(job.barcodes);}catch(err){throw new ApiError(409,'BARCODES_NOT_CONFIGURED',(err as Error).message);}}
async function scans(c:PoolClient,plan:any,seq:number,jobId:number,driverId:string){return(await c.query('SELECT barcode,scanned_at,driver_id FROM mealcart_parcel_scans WHERE plan_id=$1 AND plan_created_at=$2 AND stop_seq=$3 AND job_id=$4 AND driver_id=$5',[plan.public_id,plan.created_at,seq,jobId,driverId])).rows;}
export async function parcelState(driverId:string,planId:string,seq:number){
 const owned=(await pool.query("SELECT stop_arrivals FROM route_plans WHERE public_id=$1 AND driver_id=$2 AND status='Planned'",[planId,driverId])).rows[0];
 if(owned?.stop_arrivals.find((s:any)=>s.seq===seq)?.stopId?.startsWith('STP-C'))return collectionProofState(driverId,planId,seq);
 return transaction(async c=>{const{plan,stop,index,job}=await context(c,driverId,planId,seq,true);
 const repaired=await repairRouteReceipt(c,plan,stop,index,job);
 const completion=(await c.query('SELECT id,photos,signature_url,completed_at FROM mealcart_delivery_completions WHERE plan_id=$1 AND plan_created_at=$2 AND stop_seq=$3',[planId,plan.created_at,seq])).rows[0];
 let expected:string[]=[],configurationError='';try{expected=codes(job);}catch(err){configurationError=(err as Error).message;}
 const recorded:{barcode:string;scanned_at:Date|string}[]=repaired?(repaired.expected_barcodes??[]).map((barcode:string)=>({barcode,scanned_at:repaired.completed_at})):await scans(c,plan,seq,job.id,driverId);const known=new Map(recorded.map(r=>[r.barcode,r]));
 return{stopId:stop.stopId,doNumber:String(job.do_number??''),planCreatedAt:plan.created_at,version:plan.route_version,status:stop.status,configurationError,
 barcodes:expected.map(barcode=>({barcode,status:known.has(barcode)?'Completed':'Pending',scannedAt:known.get(barcode)?.scanned_at??null})),
 scannedCount:expected.filter(code=>known.has(code)).length,totalCount:expected.length,
 proofRetryAllowed:stop.status==='Pending'&&await canAttachMissingProof(c,job),
 proof:completion?{completionId:completion.id,photos:completion.photos,signatureUrl:completion.signature_url,completedAt:completion.completed_at}:null};});
}
export async function scanParcel(driverId:string,planId:string,seq:number,input:{stopId:string;doNumber:string;barcode:string}){
 await transaction(async c=>{const{plan,stop,job}=await context(c,driverId,planId,seq,true);
 if(stop.stopId!==input.stopId||String(job.do_number??'')!==input.doNumber)throw new ApiError(409,'ORDER_CHANGED','The order changed. Reload it before scanning.');
 if(stop.status!=='Pending')throw new ApiError(409,'STOP_NOT_PENDING','This stop is no longer pending.');
 const barcode=codes(job).find(code=>barcodeKey(code)===barcodeKey(input.barcode));
 if(!barcode)throw new ApiError(400,'WRONG_PARCEL','This label is not in this order’s saved barcode list.');
 await c.query(`INSERT INTO mealcart_parcel_scans(plan_id,plan_created_at,stop_seq,job_id,do_number,barcode,raw_barcode,driver_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(plan_id,plan_created_at,stop_seq,barcode,driver_id) DO NOTHING`,[planId,plan.created_at,seq,job.id,String(job.do_number),barcode,input.barcode,driverId]);
 });return parcelState(driverId,planId,seq);
}
export async function completeWithProof(driverId:string,planId:string,seq:number,input:ProofInput,photos:Buffer[]){
 if(input.stopId.startsWith('STP-C'))return completeCollectionWithProof(driverId,planId,seq,input,photos);
 const c=await pool.connect();let files:StoredMedia[]=[],committed=false;
 try{
  await c.query('BEGIN');const{plan,stop,index,job}=await context(c,driverId,planId,seq,true);
  if(stop.stopId!==input.stopId||String(job.do_number??'')!==input.doNumber)throw new ApiError(409,'ORDER_CHANGED','The assigned order changed. Reload it.');
  if(input.offline && input.offline.planCreatedAt!==plan.created_at)throw new ApiError(409,'OFFLINE_ROUTE_REPLACED','The saved route was deleted or replaced. Your offline proof needs office review.');
  const receipt=(await c.query(`SELECT *,to_char(plan_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS plan_created_at FROM mealcart_delivery_completions WHERE id=$1`,[input.requestId])).rows[0];
  if(receipt){await repairRouteReceipt(c,plan,stop,index,job);if(receipt.driver_id!==driverId||receipt.plan_id!==planId||receipt.stop_seq!==seq||receipt.job_id!==job.id||String(receipt.plan_created_at)!==String(plan.created_at))throw new ApiError(409,'REQUEST_CONFLICT','This completion request belongs to another order.');await c.query('COMMIT');committed=true;return parcelState(driverId,planId,seq);}
  await repairRouteReceipt(c,plan,stop,index,job);
  if(stop.status!=='Pending'||!await canAttachMissingProof(c,job))throw new ApiError(409,'ALREADY_COMPLETED','The server has a conflicting completed job or stop. Your saved photos and signature have not synced. Ask the office to review this delivery.');
  if(!input.offline && plan.route_version!==input.version)throw new ApiError(409,'ROUTE_CHANGED','The route changed. Reload before completing this order.');
  const expected=codes(job);
  if(input.offline){
   const offline=input.offline;
   const saved=offline.expectedBarcodes.map(barcodeKey).sort(),current=expected.map(barcodeKey).sort();
   if(JSON.stringify(saved)!==JSON.stringify(current))throw new ApiError(409,'OFFLINE_PARCELS_CHANGED','The office changed the parcel list. Keep this evidence for office review.');
   const recordedAt=Date.parse(offline.completedAt);
   if(recordedAt>Date.now()+300000||recordedAt<Date.parse(plan.created_at)-86400000)throw new ApiError(409,'OFFLINE_CLOCK_INVALID','The device completion time is outside this route. Check your phone clock; evidence is retained.');
   const seen=new Set<string>();
   for(const scan of offline.scans){
    const key=barcodeKey(scan.barcode),barcode=expected.find(code=>barcodeKey(code)===key),at=Date.parse(scan.scannedAt);
    if(!barcode||seen.has(key)||at>recordedAt+300000||at<Date.parse(plan.created_at)-86400000)throw new ApiError(409,'OFFLINE_SCANS_INVALID','Offline scan evidence does not match the saved job.');
    seen.add(key);
    await c.query(`INSERT INTO mealcart_parcel_scans(plan_id,plan_created_at,stop_seq,job_id,do_number,barcode,raw_barcode,driver_id,scanned_at) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8::timestamptz) ON CONFLICT(plan_id,plan_created_at,stop_seq,barcode,driver_id) DO NOTHING`,[planId,plan.created_at,seq,job.id,String(job.do_number),barcode,driverId,scan.scannedAt]);
   }
  }
  const recorded=await scans(c,plan,seq,job.id,driverId),set=new Set(recorded.map(r=>r.barcode));
  if(expected.some(code=>!set.has(code)))throw new ApiError(409,'PARCELS_MISSING',`Scan every saved parcel first (${expected.filter(code=>set.has(code)).length}/${expected.length}).`);
  files=await saveEvidence(photos,input.signature);const links=files.filter(f=>f.kind==='photo').map(f=>f.url),signature=files.find(f=>f.kind==='signature')!.url;
  const receiptRow=(await c.query(`INSERT INTO mealcart_delivery_completions(id,plan_id,plan_created_at,stop_seq,job_id,do_number,driver_id,photos,signature_url,expected_barcodes) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb) RETURNING completed_at`,[input.requestId,planId,plan.created_at,seq,job.id,String(job.do_number),driverId,JSON.stringify(links),signature,JSON.stringify(expected)])).rows[0];
  for(const f of files)await c.query('INSERT INTO mealcart_delivery_media(id,completion_id,kind,filename,mime_type) VALUES($1,$2,$3,$4,$5)',[f.id,input.requestId,f.kind,f.filename,f.mime]);
  await c.query(`UPDATE jobs SET status='completed',completion_photos=$2::jsonb,completion_signature_url=$3,completion_driver_id=$4,completion_recorded_at=$5 WHERE id=$1`,[job.id,JSON.stringify(links),signature,driverId,receiptRow.completed_at]);
  const completed={...stop,...(input.offline?{offlineRecordedAt:input.offline.completedAt,offlineScans:input.offline.scans,offlineSyncedAt:new Date(receiptRow.completed_at).toISOString()}:{}),status:'Completed',completedAt:new Date(receiptRow.completed_at).toISOString(),completedByDriverId:driverId,proof:{photos:links,signatureUrl:signature,parcelCount:expected.length,completionId:input.requestId}};
  await c.query(`UPDATE route_plans SET stop_arrivals=jsonb_set(stop_arrivals,$1::text[],$2::jsonb,false),completion_photos=jsonb_set(completion_photos,$3::text[],$4::jsonb,true),completion_signatures=jsonb_set(completion_signatures,$3::text[],$5::jsonb,true),route_version=route_version+1,updated_at=NOW() WHERE public_id=$6`,[`{${index}}`,JSON.stringify(completed),[stop.stopId],JSON.stringify(links),JSON.stringify(signature),planId]);
  await c.query('COMMIT');committed=true;
 }catch(err){
  await c.query('ROLLBACK').catch(()=>{});
  // A connection error during COMMIT has an uncertain outcome: never delete files
  // unless a fresh read confirms the receipt did not commit.
  if(files.length&&!committed){try{const check=await c.query('SELECT id FROM mealcart_delivery_completions WHERE id=$1',[input.requestId]);if(!check.rows.length)await removeMedia(files);}catch{/* preserve files for recovery */}}
  throw err;
 }finally{c.release();}
 return parcelState(driverId,planId,seq);
}

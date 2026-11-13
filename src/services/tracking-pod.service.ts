import {createHmac} from 'node:crypto';
import {trackingOrderForToken} from './customer-tracking.service.js';
import {ApiError} from '../types/api.types.js';
export async function trackingPod(token:string){
 const {link,source,order}=await trackingOrderForToken(token);
 if(!['completed','delivered'].includes(String(order.status).toLowerCase()))throw new ApiError(409,'POD_NOT_READY','The POD is available after this order is completed and synced.');
 const secret=process.env.POD_MEDIA_SECRET??'';
 if(secret.length<32)throw new ApiError(503,'POD_NOT_CONFIGURED','POD downloads are temporarily unavailable. Contact Mealcart.');
 let base:URL;try{base=new URL(process.env.PORTAL_API_BASE_URL??'');}catch{throw new ApiError(503,'POD_PORTAL_NOT_CONFIGURED','POD downloads are temporarily unavailable. Please contact Mealcart.');}
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new ApiError(503,'POD_PORTAL_NOT_CONFIGURED','POD downloads are temporarily unavailable. Please contact Mealcart.');
 const payload={source,id:link.job_id,reference:link.do_number,customerId:String(link.customer_id),date:link.date,expires:String(Math.floor(Date.now()/1000)+90)};
 const signature=createHmac('sha256',secret).update('mealcart-tracking-pod-v1\n'+JSON.stringify([payload.source,payload.id,payload.reference,payload.customerId,payload.date,payload.expires])).digest('hex');
 let response:Response;try{response=await fetch(new URL('/api/internal/tracking-pod',base),{method:'POST',headers:{'Content-Type':'application/json','x-mealcart-pod-signature':signature},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(120000)});}catch{throw new ApiError(502,'POD_BACKEND_UNAVAILABLE','The POD could not be generated. Please retry shortly.');}
 if(!response.ok){
  const status=response.status;await response.body?.cancel();
  throw new ApiError(status===409?409:502,'POD_GENERATION_FAILED',status===409?'This order is not ready for a POD yet.':'The POD could not be generated. Please retry shortly or contact Mealcart.');
 }
 if(!response.headers.get('content-type')?.includes('application/pdf')){await response.body?.cancel();throw new ApiError(502,'INVALID_POD_RESPONSE','The POD service did not return a PDF.');}
 const max=32*1024*1024;if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw new ApiError(502,'POD_TOO_LARGE','The POD exceeds the download size limit. Contact Mealcart.');}
 const reader=response.body?.getReader();if(!reader)throw new ApiError(502,'INVALID_POD_RESPONSE','The POD service returned an empty response.');
 const chunks:Buffer[]=[];let length=0;try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>max){await reader.cancel();throw new ApiError(502,'POD_TOO_LARGE','The POD exceeds the download size limit. Contact Mealcart.');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 const pdf=Buffer.concat(chunks);if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new ApiError(502,'INVALID_POD_RESPONSE','The POD service returned an invalid PDF.');
 return{pdf,filename:`POD_${String(link.do_number).replace(/[^A-Za-z0-9._-]/g,'_')}.pdf`};
}

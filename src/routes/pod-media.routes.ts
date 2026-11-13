import {createHmac,timingSafeEqual} from 'node:crypto';
import {Router} from 'express';
import {ApiError} from '../types/api.types.js';
import {asyncHandler} from '../utils/async-handler.js';
import {sendProofFile} from '../services/proof-file.service.js';
export function verifyPodMedia(id:string,expires:string,signature:string,secret:string,now=Date.now()){
 if(secret.length<32)throw new ApiError(503,'POD_MEDIA_NOT_CONFIGURED','Configure POD_MEDIA_SECRET on both Mealcart backends.');
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)||!/^\d{10}$/.test(expires)||! /^[a-f0-9]{64}$/.test(signature))throw new ApiError(403,'INVALID_POD_MEDIA','Invalid POD media authorization.');
 const remaining=Number(expires)-Math.floor(now/1000);
 if(remaining<0||remaining>120)throw new ApiError(403,'EXPIRED_POD_MEDIA','POD media authorization expired. Retry the download.');
 const expected=createHmac('sha256',secret).update(`mealcart-pod-v1\n${id}\n${expires}`).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new ApiError(403,'INVALID_POD_MEDIA','Invalid POD media authorization.');
}
export const podMediaRouter=Router();
podMediaRouter.get('/internal/pod-media/:id',asyncHandler(async(req,res)=>{
 const expires=String(req.query.expires??''),signature=req.get('x-mealcart-pod-signature')??'';
 verifyPodMedia(req.params.id,expires,signature,process.env.POD_MEDIA_SECRET??'');
 await sendProofFile(res,req.params.id);
}));

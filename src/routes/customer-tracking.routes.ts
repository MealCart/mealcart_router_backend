import {Router} from 'express';
import {asyncHandler} from '../utils/async-handler.js';
import {ApiError} from '../types/api.types.js';
import {publicOrderTracking} from '../services/customer-tracking.service.js';

export const customerTrackingRouter=Router();
customerTrackingRouter.use((_req,res,next)=>{
 res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});
 next();
});
const windows=new Map<string,{started:number;count:number}>();
let lastCleanup=0;
customerTrackingRouter.use((req,res,next)=>{
 const now=Date.now(),windowMs=60_000;
 if(now-lastCleanup>=windowMs){
  for(const [key,value] of windows)if(now-value.started>=windowMs)windows.delete(key);
  lastCleanup=now;
 }
 const key=req.ip||req.socket.remoteAddress||'unknown';
 const previous=windows.get(key);
 const bucket=previous&&now-previous.started<windowMs?previous:{started:now,count:0};
 if((!windows.has(key)&&windows.size>=10000)||++bucket.count>120){
  res.set('Retry-After','60');
  return next(new ApiError(429,'TRACKING_RATE_LIMIT','Please wait a moment before refreshing tracking.'));
 }
 windows.set(key,bucket);
 next();
});
customerTrackingRouter.post('/lookup',asyncHandler(async(req,res)=>{
 const token=req.body?.token;
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new ApiError(404,'TRACKING_UNAVAILABLE','This tracking link is unavailable or has expired.');
 res.json({ok:true,data:await publicOrderTracking(token)});
}));

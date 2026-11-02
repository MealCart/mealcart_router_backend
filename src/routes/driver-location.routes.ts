import {Router} from 'express';
import {asyncHandler} from '../utils/async-handler.js';
import {validateBody} from '../middleware/validate.middleware.js';
import {ApiError} from '../types/api.types.js';
import {trackingSessionSchema,trackingPointSchema} from '../validators/driver-location.validator.js';
import {latestDriverLocations,startDriverTracking,stopDriverTracking,recordDriverLocation,subscribeDriverLocations} from '../services/driver-location.service.js';
import {joinTrackingFeed} from '../services/driver-location-feed.service.js';
import {sessionToken} from '../middleware/auth.middleware.js';
import {sessionUser} from '../services/auth.service.js';
export const mobileLocationRouter=Router();
const windows=new Map<string,{at:number;count:number}>();
mobileLocationRouter.use('/tracking',(req,res,next)=>{const now=Date.now(),id=res.locals.driver.id;for(const[k,v]of windows)if(v.at+60000<now)windows.delete(k);const bucket=windows.get(id)??{at:now,count:0};if(++bucket.count>60)return next(new ApiError(429,'GPS_RATE_LIMIT','Too many location updates. Retry shortly.'));windows.set(id,bucket);next();});
mobileLocationRouter.post('/tracking/start',validateBody(trackingSessionSchema),asyncHandler(async(req,res)=>{res.json({ok:true,data:await startDriverTracking(res.locals.driver.id,req.body.sessionId)});}));
mobileLocationRouter.post('/tracking/stop',validateBody(trackingSessionSchema),asyncHandler(async(req,res)=>{res.json({ok:true,data:await stopDriverTracking(res.locals.driver.id,req.body.sessionId)});}));
mobileLocationRouter.post('/tracking/location',validateBody(trackingPointSchema),asyncHandler(async(req,res)=>{res.json({ok:true,data:await recordDriverLocation(res.locals.driver.id,req.body)});}));
// Mounted after the existing admin/staff session middleware.
export const adminLocationRouter=Router();
adminLocationRouter.get('/tracking/locations',asyncHandler(async(_req,res)=>{res.json({ok:true,data:await latestDriverLocations()});}));
adminLocationRouter.get('/tracking/stream',asyncHandler(async(req,res)=>{
 const leave=await joinTrackingFeed();
 if(req.aborted||res.destroyed){leave();return;}
 res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();res.write('retry: 3000\n\n');
 const send=(event:string,data:unknown)=>{if(res.destroyed)return;if(res.writableLength>256*1024){res.end();return;}res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
 const unsubscribe=subscribeDriverLocations(location=>send('location',location));
 let closed=false;const close=()=>{if(closed)return;closed=true;clearInterval(heartbeat);clearInterval(authCheck);unsubscribe();leave();};
 const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},20000);heartbeat.unref?.();
 const token=sessionToken(req);let checking=false;
 const authCheck=setInterval(()=>{if(checking)return;checking=true;void sessionUser(token).then(user=>{if(!user){send('unauthorized',{});res.end();}}).catch(()=>res.end()).finally(()=>{checking=false;});},60000);authCheck.unref?.();
 res.once('close',close);res.once('error',close);
 try{send('snapshot',await latestDriverLocations());}catch{send('feed-error',{message:'Could not load GPS positions. Reconnecting…'});res.end();}
}));

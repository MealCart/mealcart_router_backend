import {deliveryProofRouter} from "./delivery-proof.routes.js";
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/async-handler.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { driverBearer,driverMobileAuth } from '../middleware/driver-mobile-auth.middleware.js';
import { driverLogin,driverLogout } from '../services/driver-mobile-auth.service.js';
import { listDriverRoutes,getDriverRoute,completeDriverStop } from '../services/driver-mobile-routes.service.js';
import { ApiError } from '../types/api.types.js';
export const driverMobileRouter=Router();
// This router uses bearer authentication, never admin cookies or X-API-Token.
const attempts=new Map<string,{count:number;until:number}>();
const loginSchema=z.object({username:z.string().trim().min(1).max(60),password:z.string().min(1).max(200)}).strict();
driverMobileRouter.post('/auth/login',validateBody(loginSchema),asyncHandler(async(req,res)=>{
 const now=Date.now();for(const[key,v]of attempts)if(v.until<=now)attempts.delete(key);
 const key=req.ip??'unknown';const bucket=attempts.get(key)??{count:0,until:now+15*60*1000};
 if(bucket.count>=20)throw new ApiError(429,'LOGIN_RATE_LIMIT','Too many attempts. Try again in 15 minutes.');
 if(attempts.size>=10000&&!attempts.has(key))throw new ApiError(429,'LOGIN_RATE_LIMIT','Please try again later.');
 bucket.count++;attempts.set(key,bucket);
 const result=await driverLogin(req.body.username,req.body.password);
 res.setHeader('Cache-Control','no-store');res.json({ok:true,data:result});
}));
driverMobileRouter.use(driverMobileAuth);
driverMobileRouter.use(deliveryProofRouter);
driverMobileRouter.get('/auth/me',(_req,res)=>{res.json({ok:true,data:res.locals.driver});});
driverMobileRouter.post('/auth/logout',asyncHandler(async(req,res)=>{await driverLogout(driverBearer(req));res.status(204).send();}));
driverMobileRouter.get('/routes',asyncHandler(async(req,res)=>{
 const date=String(req.query.date??'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new ApiError(400,'BAD_DATE','Use a valid YYYY-MM-DD date.');
 res.json({ok:true,data:await listDriverRoutes(res.locals.driver.id,date)});
}));
driverMobileRouter.get('/routes/:id',asyncHandler(async(req,res)=>{res.json({ok:true,data:await getDriverRoute(res.locals.driver.id,req.params.id)});}));
const completeSchema=z.object({stopId:z.string().min(1).max(100),version:z.number().int().positive()}).strict();
driverMobileRouter.post('/routes/:id/stops/:seq/complete',validateBody(completeSchema),asyncHandler(async(req,res)=>{
 const seq=Number(req.params.seq);if(!Number.isInteger(seq)||seq<1)throw new ApiError(400,'BAD_SEQ','Invalid stop sequence.');
 res.json({ok:true,data:await completeDriverStop(res.locals.driver.id,req.params.id,seq,req.body.stopId,req.body.version)});
}));
driverMobileRouter.use((_req,_res,next)=>next(new ApiError(404,'NOT_FOUND','Driver endpoint not found.')));

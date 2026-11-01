import type { Request, Response, NextFunction } from 'express';
import { mobileSession } from '../services/driver-mobile-auth.service.js';
import { ApiError } from '../types/api.types.js';
export const driverBearer=(req:Request)=>(req.get('authorization')??'').match(/^Bearer ([a-f0-9]{64})$/)?.[1]??'';
export function driverMobileAuth(req:Request,res:Response,next:NextFunction){
 void mobileSession(driverBearer(req)).then(driver=>{
  if(!driver)return next(new ApiError(401,'DRIVER_UNAUTHORIZED','Please sign in to your driver account.'));
  res.locals.driver=driver;res.setHeader('Cache-Control','no-store');next();
 }).catch(next);
}

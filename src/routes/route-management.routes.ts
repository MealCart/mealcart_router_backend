import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../types/api.types.js';
import {listManagedRoutes,manageRoute} from '../services/route-management.service.js';
export const routeManagementRouter=Router();
// Mounted by routePlanRouter behind the API's existing admin/staff authentication and origin checks.
routeManagementRouter.get('/route-plan-management',asyncHandler(async(req,res)=>{
 const date=req.query.date;
 if(date!==undefined&&(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)))throw new ApiError(400,'INVALID_DATE','Choose a valid route date.');
 res.json({ok:true,data:await listManagedRoutes(date as string|undefined)});
}));
routeManagementRouter.patch('/route-plans/:id/driver',asyncHandler(async(req,res)=>{
 const {driverId,version}=req.body??{};
 if(typeof driverId!=='string'||!driverId.trim()||driverId.length>40||!Number.isInteger(version)||version<0)throw new ApiError(400,'INVALID_ASSIGNMENT','Choose a driver and reload the route version.');
 res.json({ok:true,data:await manageRoute(String(req.params.id),version,driverId)});
}));
routeManagementRouter.delete('/route-plans/:id/release',asyncHandler(async(req,res)=>{
 const version=Number(req.query.version);
 if(req.query.version===undefined||!Number.isInteger(version)||version<0)throw new ApiError(400,'INVALID_VERSION','Reload the route before deleting it.');
 res.json({ok:true,data:await manageRoute(String(req.params.id),version)});
}));

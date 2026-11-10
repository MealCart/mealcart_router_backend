import {Router} from 'express';
import {asyncHandler} from '../utils/async-handler.js';
import {assignedRouteProofDetails} from '../services/assigned-route-proof.service.js';
import {sendProofFile} from '../services/proof-file.service.js';
export const completionRepairRouter=Router();
// Mounted after existing admin/staff authentication, before the generic route routers.
completionRepairRouter.get('/route-plans/:id/details',asyncHandler(async(req,res)=>{res.json({ok:true,data:await assignedRouteProofDetails(String(req.params.id))});}));
completionRepairRouter.get('/proof-files/:id',asyncHandler(async(req,res)=>{await sendProofFile(res,String(req.params.id));}));

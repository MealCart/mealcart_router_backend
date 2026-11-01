import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { registerKeySchema, issueKeySchema, keyMovementSchema } from "../validators/key.validator.js";
import { listKeys, getKey, registerKey, issueKey, receiveOrCancelKey } from "../services/key.service.js";
// Mount after existing admin/staff auth and trusted-origin middleware.
export const keyRouter=Router();
keyRouter.get('/keys',asyncHandler(async (_req,res)=>{res.json({ok:true,data:await listKeys()});}));
keyRouter.get('/keys/:id',asyncHandler(async (req,res)=>{res.json({ok:true,data:await getKey(req.params.id)});}));
keyRouter.post('/keys',validateBody(registerKeySchema),asyncHandler(async(req,res)=>{res.status(201).json({ok:true,data:await registerKey(req.body,res.locals.user.id)});}));
keyRouter.post('/keys/:id/issue',validateBody(issueKeySchema),asyncHandler(async(req,res)=>{res.json({ok:true,data:await issueKey(req.params.id,req.body,res.locals.user.id)});}));
keyRouter.post('/keys/:id/receive',validateBody(keyMovementSchema),asyncHandler(async(req,res)=>{res.json({ok:true,data:await receiveOrCancelKey(req.params.id,req.body,res.locals.user.id,'Received')});}));
keyRouter.post('/keys/:id/cancel',validateBody(keyMovementSchema),asyncHandler(async(req,res)=>{res.json({ok:true,data:await receiveOrCancelKey(req.params.id,req.body,res.locals.user.id,'Cancelled')});}));
// No public barcode-only or admin impersonation acceptance endpoint.

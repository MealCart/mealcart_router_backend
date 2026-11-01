import {Router} from 'express';
import {asyncHandler} from '../utils/async-handler.js';
import {validateBody} from '../middleware/validate.middleware.js';
import {proofUpload} from '../middleware/proof-upload.middleware.js';
import {scanSchema,proofSchema} from '../validators/delivery-proof.validator.js';
import {parcelState,scanParcel,completeWithProof} from '../services/delivery-proof.service.js';
import {sendProofFile} from '../services/proof-file.service.js';
import {ApiError} from '../types/api.types.js';
const resRelease=(res:import("express").Response)=>res.locals.releaseProofSlot?.();
export const deliveryProofRouter=Router();
const seq=(value:string)=>{const n=Number(value);if(!Number.isInteger(n)||n<1)throw new ApiError(400,'BAD_SEQ','Invalid stop sequence.');return n;};
// Mounted inside the existing authenticated driver router.
deliveryProofRouter.get('/routes/:id/stops/:seq/parcels',asyncHandler(async(req,res)=>{res.json({ok:true,data:await parcelState(res.locals.driver.id,req.params.id,seq(req.params.seq))});}));
deliveryProofRouter.post('/routes/:id/stops/:seq/scan',validateBody(scanSchema),asyncHandler(async(req,res)=>{res.json({ok:true,data:await scanParcel(res.locals.driver.id,req.params.id,seq(req.params.seq),req.body)});}));
deliveryProofRouter.post('/routes/:id/stops/:seq/proof',proofUpload,(req,_res,next)=>{const result=proofSchema.safeParse(req.body);if(!result.success){resRelease(_res);return next(new ApiError(400,"INVALID_PROOF",result.error.issues[0]?.message??"Invalid proof data."));}req.body=result.data;next();},asyncHandler(async(req,res)=>{try{const files=(req.files as Express.Multer.File[]|undefined)??[];res.json({ok:true,data:await completeWithProof(res.locals.driver.id,req.params.id,seq(req.params.seq),req.body,files.map(file=>file.buffer))});}finally{resRelease(res);}}));
deliveryProofRouter.get('/proof-files/:id',asyncHandler(async(req,res)=>{await sendProofFile(res,req.params.id,res.locals.driver.id);}));
// Mount behind existing admin/staff cookie auth; no public static uploads directory.
export const adminProofRouter=Router();
adminProofRouter.get('/proof-files/:id',asyncHandler(async(req,res)=>{await sendProofFile(res,req.params.id);}));

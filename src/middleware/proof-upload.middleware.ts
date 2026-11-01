import multer from 'multer';
import type {Request,Response,NextFunction} from 'express';
import {ApiError} from '../types/api.types.js';
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:6,fields:6,fieldSize:256000,parts:12}}).array('photos',6);
let active=0;
export function proofUpload(req:Request,res:Response,next:NextFunction){
 if(active>=2)return next(new ApiError(503,'UPLOAD_BUSY','The upload server is busy. Keep your photos and retry shortly.'));
 active++;let parsed=false;let released=false;const release=()=>{if(!released){released=true;active--;}};res.locals.releaseProofSlot=release;res.once('finish',release);res.once('close',()=>{if(!parsed)release();});
 upload(req,res,(err:unknown)=>{parsed=true;if(req.aborted||res.destroyed){release();return;}if(err){release();return next(new ApiError(400,'INVALID_UPLOAD','Upload up to 6 photos, each smaller than 8 MB.'));}next();});
}

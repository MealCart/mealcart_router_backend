import path from 'node:path';
import type {Response} from 'express';
import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
import {proofDirectory} from './proof-storage.service.js';
export async function sendProofFile(res:Response,id:string,driverId?:string){
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))throw new ApiError(404,'FILE_NOT_FOUND','Proof file not found.');
 const row=(await pool.query(`SELECT m.filename,m.mime_type,c.driver_id FROM mealcart_delivery_media m JOIN mealcart_delivery_completions c ON c.id=m.completion_id WHERE m.id=$1 UNION ALL SELECT m.filename,m.mime_type,c.driver_id FROM mealcart_collection_media m JOIN mealcart_collection_completions c ON c.id=m.completion_id WHERE m.id=$1`,[id])).rows[0];
 if(!row||(driverId&&row.driver_id!==driverId)||!/^([a-f0-9-]{36})\.(jpg|png)$/.test(row.filename))throw new ApiError(404,'FILE_NOT_FOUND','Proof file not found.');
 res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.type(row.mime_type);
 await new Promise<void>((resolve,reject)=>res.sendFile(path.join(proofDirectory(),row.filename),(error)=>error?reject(new ApiError(404,'FILE_UNAVAILABLE','This proof image is unavailable on the server disk.')):resolve()));
}

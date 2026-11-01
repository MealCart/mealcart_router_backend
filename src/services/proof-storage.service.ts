import {mkdir,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {ApiError} from '../types/api.types.js';
import type {ProofInput} from '../validators/delivery-proof.validator.js';
sharp.concurrency(1);sharp.cache(false);
export const proofDirectory=()=>path.resolve(process.env.UPLOAD_DIR??'uploads');
export function proofUrl(id:string){const origin=(process.env.PUBLIC_API_URL??'').replace(/\/+$/,'');return `${origin}/api/proof-files/${id}`;}
export interface StoredMedia {id:string;filename:string;mime:string;url:string;kind:'photo'|'signature';}
export async function removeMedia(files:StoredMedia[]){await Promise.all(files.map(f=>unlink(path.join(proofDirectory(),f.filename)).catch(()=>{})));}
export async function saveEvidence(photos:Buffer[],signature:ProofInput['signature']):Promise<StoredMedia[]>{
 if(process.env.RENDER&&!process.env.UPLOAD_DIR)throw new ApiError(503,'UPLOAD_DISK_REQUIRED','Configure UPLOAD_DIR on the Render persistent disk before completing deliveries.');
 if(photos.length<1||photos.length>6)throw new ApiError(400,'PHOTOS_REQUIRED','Capture between 1 and 6 delivery photos.');
 await mkdir(proofDirectory(),{recursive:true});const files:StoredMedia[]=[];
 const save=async(buffer:Buffer,kind:StoredMedia['kind'],mime:string)=>{const id=randomUUID(),filename=`${id}.${kind==='photo'?'jpg':'png'}`;const handle=await open(path.join(proofDirectory(),filename),'wx',0o600);files.push({id,filename,mime,kind,url:proofUrl(id)});try{await handle.writeFile(buffer);await handle.sync();}finally{await handle.close();}};
 try{
  for(const image of photos){
   let output:Buffer;try{const metadata=await sharp(image,{limitInputPixels:30000000}).metadata();if(!['jpeg','png','webp','heif'].includes(metadata.format??'')||(metadata.width??0)<160||(metadata.height??0)<160)throw Error('Unsupported image');output=await sharp(image,{limitInputPixels:30000000}).rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();}catch{throw new ApiError(400,'INVALID_PHOTO','One photo could not be read. Capture a new JPEG or PNG photo.');}
   await save(output,'photo','image/jpeg');
  }
  const paths=signature.strokes.map(stroke=>`<path d="${stroke.map(([x,y],i)=>`${i?'L':'M'}${(x*1000).toFixed(2)},${(y*600).toFixed(2)}`).join(' ')}"/>`).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="white"/><g fill="none" stroke="#142c39" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
  await save(await sharp(Buffer.from(svg)).png().toBuffer(),'signature','image/png');return files;
 }catch(err){await removeMedia(files);throw err;}
}

import {z} from 'zod';
const point=z.tuple([z.number().finite().min(0).max(1),z.number().finite().min(0).max(1)]);
export const signatureSchema=z.object({strokes:z.array(z.array(point).min(2).max(1500)).min(1).max(50)}).strict().superRefine((v,ctx)=>{
 let count=0,length=0;for(const stroke of v.strokes){count+=stroke.length;for(let i=1;i<stroke.length;i++)length+=Math.hypot(stroke[i][0]-stroke[i-1][0],stroke[i][1]-stroke[i-1][1]);}
 if(count<8||count>5000||length<.12)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Draw a complete driver signature.'});
});
export const scanSchema=z.object({stopId:z.string().min(1).max(100),doNumber:z.string().min(1).max(200),barcode:z.string().trim().min(1).max(256)}).strict();
export const offlineIdentitySchema=z.object({planCreatedAt:z.string().datetime({precision:6}),completedAt:z.string().datetime(),requestId:z.string().uuid()}).strict();
export const offlineEvidenceSchema=z.object({planCreatedAt:z.string().datetime({precision:6}),completedAt:z.string().datetime(),expectedBarcodes:z.array(z.string().min(1).max(256)).max(500),scans:z.array(z.object({barcode:z.string().min(1).max(256),scannedAt:z.string().datetime()}).strict()).max(500)}).strict();
const offlineField=z.string().max(256000).transform((value,ctx)=>{try{return JSON.parse(value);}catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid offline evidence.'});return z.NEVER;}}).pipe(offlineEvidenceSchema).optional();
export const proofSchema=z.object({stopId:z.string().min(1).max(100),doNumber:z.string().min(1).max(200),version:z.coerce.number().int().positive(),requestId:z.string().uuid(),signature:z.string().max(256000).transform((value,ctx)=>{try{return JSON.parse(value);}catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid signature data.'});return z.NEVER;}}).pipe(signatureSchema),offline:offlineField}).strict();
export type ProofInput=z.infer<typeof proofSchema>;
export function barcodeKey(value:string){return value.trim().replace(/^#/,'');}
export function expectedBarcodes(value:unknown):string[]{
 let raw=value;if(typeof raw==='string'){try{raw=JSON.parse(raw);}catch{throw new Error('The job barcodes column must contain a JSON array of barcode strings.');}}
 if(!Array.isArray(raw)||!raw.length||raw.length>500||raw.some(v=>typeof v!=='string'||!v.trim()||v.trim().length>256))throw new Error('This job needs a valid non-empty barcode list from the office.');
 const codes=raw.map((v:string)=>v.trim());if(new Set(codes.map(barcodeKey)).size!==codes.length)throw new Error('The job contains duplicate or ambiguous parcel barcodes. Contact the office.');return codes;
}

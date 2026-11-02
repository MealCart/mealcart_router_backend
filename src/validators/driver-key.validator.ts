import {z} from 'zod';
export const keyBarcodeSchema=z.string().trim().max(40).transform(v=>v.toUpperCase()).pipe(z.string().regex(/^KEY-[0-9]{8,32}$/,'Scan a valid Mealcart key barcode.'));
export const acceptDriverKeySchema=z.object({issueId:z.string().uuid(),barcode:keyBarcodeSchema}).strict();
export const requestDriverKeyReturnSchema=z.object({issueId:z.string().uuid(),notes:z.string().trim().max(2000).default('')}).strict();

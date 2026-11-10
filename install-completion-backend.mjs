import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const file='src/services/delivery-proof.service.ts',index='src/routes/index.ts';
if(!existsSync(file)||!existsSync(index)||!existsSync('src/services/completion-reconciliation.service.ts'))throw new Error('Merge server/src, then run this installer from the BACKEND root.');
let proof=readFileSync(file,'utf8'),routes=readFileSync(index,'utf8');
if(!proof.includes('// Completion consistency repair v1')){
 const replace=(a,b)=>{if(!proof.includes(a))throw new Error('Unsupported proof service version; no files changed. Send src/services/delivery-proof.service.ts. Missing '+a.slice(0,60));proof=proof.replace(a,b);};
 proof="// Completion consistency repair v1\nimport {repairRouteReceipt,canAttachMissingProof} from './completion-reconciliation.service.js';\n"+proof;
 replace('const{plan,stop,job}=await context(c,driverId,planId,seq,true);','const{plan,stop,index,job}=await context(c,driverId,planId,seq,true);\n const repaired=await repairRouteReceipt(c,plan,stop,index,job);');
 replace("proof:completion?{completionId:completion.id", "proofRetryAllowed:stop.status==='Pending'&&await canAttachMissingProof(c,job),\n proof:completion?{completionId:completion.id");
 // A valid completion receipt confirms the parcel set even after driver reassignment.
 replace("const recorded=await scans(c,plan,seq,job.id,driverId);const known=", "const recorded:{barcode:string;scanned_at:Date|string}[]=repaired?(repaired.expected_barcodes??[]).map((barcode:string)=>({barcode,scanned_at:repaired.completed_at})):await scans(c,plan,seq,job.id,driverId);const known=");
 replace("  if(stop.status!=='Pending'||job.status==='completed')throw", "  await repairRouteReceipt(c,plan,stop,index,job);\n  if(stop.status!=='Pending'||!await canAttachMissingProof(c,job))throw");
 replace('This job or stop is already completed or no longer pending. Reload its status.', 'The server has a conflicting completed job or stop. Your saved photos and signature have not synced. Ask the office to review this delivery.');
 // Idempotent duplicate requests must also heal a pending route before returning success.
 replace("if(receipt){if(receipt.driver_id", "if(receipt){await repairRouteReceipt(c,plan,stop,index,job);if(receipt.driver_id");
}
if(!routes.includes('completionRepairRouter')){
 if(!routes.includes('apiRouter.use(authMiddleware);'))throw new Error('Admin authentication mount not found. No files changed.');
 routes="import {completionRepairRouter} from './completion-repair.routes.js';\n"+routes.replace('apiRouter.use(authMiddleware);','apiRouter.use(authMiddleware);\napiRouter.use(completionRepairRouter);');
}
writeFileSync(file,proof);writeFileSync(index,routes);
console.log('Completion repair and authenticated admin route details installed. Run npm run build; deploy the backend API.');

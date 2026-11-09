import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
// Run from the existing backend root AFTER merging server/src files.
const index=resolve('src/routes/index.ts'),worker=resolve('src/workers/delivery-notifications.ts');
if(!existsSync(index)||!existsSync(worker)||!existsSync('src/routes/pallet.routes.ts'))throw new Error('Run this script from the Mealcart backend root after merging server/src.');
let routes=readFileSync(index,'utf8'),ticks=readFileSync(worker,'utf8');
if(!routes.includes('mobilePalletRouter')){
 const mobile=/^.*apiRouter\.use\(["']\/driver-mobile["']\s*,\s*driverMobileRouter\s*\);.*$/m;
 const admin=/apiRouter\.use\(authMiddleware\);/;
 if(!mobile.test(routes)||!admin.test(routes))throw new Error('Could not locate mobile/admin router anchors. No files changed. Contact developer with src/routes/index.ts.');
 routes="import {palletRouter,mobilePalletRouter} from './pallet.routes.js';\n"+routes;
 routes=routes.replace(mobile,match=>'apiRouter.use("/driver-mobile/pallets",mobilePalletRouter);\n'+match).replace(admin,match=>match+'\napiRouter.use(palletRouter);');
}
if(!ticks.includes('dispatchPalletEmails')){
 const tick=/export async function notificationTick\(\)\s*\{/;
 if(!tick.test(ticks))throw new Error('Could not locate notificationTick. No files changed. Contact developer with worker file.');
 ticks="import {dispatchPalletEmails} from '../services/pallet-email.service.js';\n"+ticks;
 ticks=ticks.replace(tick,'async function palletBaseNotificationTick(){');
 ticks+='\nexport async function notificationTick(){\n await palletBaseNotificationTick();\n await dispatchPalletEmails().catch(error=>{console.error(\'Pallet email processing failed:\',error instanceof Error?error.message:\'Unknown error\');});\n}\n';
}
writeFileSync(index,routes);writeFileSync(worker,ticks);
console.log('Pallet API and email worker integrated. Existing route/key/tracking features kept. Run npm run build, commit all updated files, then deploy API and cron.');

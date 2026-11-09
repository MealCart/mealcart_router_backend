import {dispatchPalletEmails} from '../services/pallet-email.service.js';
import {pool} from '../db/pool.js';
import {messaging} from '../config/delivery-messaging.js';
import {refreshTrafficEtas} from '../services/traffic-eta.service.js';
import {discoverNotices,dispatchNotices} from '../services/delivery-notification.service.js';
async function palletBaseNotificationTick(){
 const c=await pool.connect();let locked=false;
 try{locked=(await c.query('SELECT pg_try_advisory_lock(740321,10) AS locked')).rows[0].locked;if(!locked)return;
  if(messaging.NOTIFICATIONS_ENABLED){await discoverNotices();await dispatchNotices();await refreshTrafficEtas();await discoverNotices();await dispatchNotices();}
  await c.query(`INSERT INTO mealcart_notification_worker_health(id,checked_at,last_error) VALUES(1,clock_timestamp(),$1) ON CONFLICT(id) DO UPDATE SET checked_at=EXCLUDED.checked_at,last_error=EXCLUDED.last_error`,[messaging.NOTIFICATIONS_ENABLED?'':'NOTIFICATIONS_ENABLED=false; worker is paused']);
 }catch(error){await c.query(`INSERT INTO mealcart_notification_worker_health(id,checked_at,last_error) VALUES(1,clock_timestamp(),$1) ON CONFLICT(id) DO UPDATE SET checked_at=EXCLUDED.checked_at,last_error=EXCLUDED.last_error`,[(error as Error).message]).catch(()=>{});throw error;}finally{try{if(locked)await c.query('SELECT pg_advisory_unlock(740321,10)');}finally{c.release();}}
}
async function main(){
 if(process.argv.includes('--once')){try{await notificationTick();}finally{await pool.end();}return;}
 let stop=false;process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
 while(!stop){try{await notificationTick();}catch{console.error('Delivery notification tick failed. Check notification worker health.');}for(let i=0;i<30&&!stop;i++)await new Promise(r=>setTimeout(r,1000));}
 await pool.end();
}
void main().catch(()=>{console.error('Delivery notification worker failed');process.exitCode=1;});

export async function notificationTick(){
 await palletBaseNotificationTick();
 await dispatchPalletEmails().catch(error=>{console.error('Pallet email processing failed:',error instanceof Error?error.message:'Unknown error');});
}

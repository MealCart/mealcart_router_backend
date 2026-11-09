import {pool} from '../db/pool.js';
import {messaging} from '../config/delivery-messaging.js';
import {sendNotification,ProviderFailure} from './notification-provider.service.js';
import {ApiError} from '../types/api.types.js';
import {emailValid} from './pallet.service.js';
/** An independent email-only outbox. Existing delivery SMS/templates are untouched. */
export async function dispatchPalletEmails(){
 if(!messaging.NOTIFICATIONS_ENABLED)return;
 await pool.query(`UPDATE mealcart_pallet_emails SET status='unknown',detail='Worker stopped during sending. Check SMTP/provider records before any resend.' WHERE status='sending' AND attempted_at<clock_timestamp()-interval '5 minutes'`);
 const deadline=Date.now()+20000;
 for(let i=0;i<20&&Date.now()<deadline;i++){
  const message=(await pool.query(`WITH next AS (SELECT id FROM mealcart_pallet_emails WHERE status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
   UPDATE mealcart_pallet_emails e SET status='sending',attempted_at=clock_timestamp(),attempts=attempts+1 FROM next WHERE e.id=next.id RETURNING e.*`)).rows[0];
  if(!message)break;
  try{const providerId=await sendNotification({id:message.id,channel:'Email',recipient:message.recipient,subject:message.subject,body:message.body});
   await pool.query(`UPDATE mealcart_pallet_emails SET status='accepted',sent_at=clock_timestamp(),provider_id=$2,detail='SMTP provider accepted this email; inbox delivery is not confirmed.' WHERE id=$1 AND status='sending'`,[message.id,providerId]);
  }catch(error){const status=error instanceof ProviderFailure?error.disposition:'unknown';const detail=error instanceof ProviderFailure?error.message:'Email sending was interrupted. Check provider records before resending.';await pool.query(`UPDATE mealcart_pallet_emails SET status=$2,detail=$3 WHERE id=$1 AND status='sending'`,[message.id,status,detail]);}
 }
}
export async function retryPalletEmail(id:string){
 const c=await pool.connect();try{await c.query('BEGIN');
 const e=(await c.query(`SELECT e.*,m.customer_id,m.driver_id FROM mealcart_pallet_emails e JOIN mealcart_pallet_movements m ON m.id=e.movement_id WHERE e.id=$1 FOR UPDATE OF e`,[id])).rows[0];
 if(!e)throw new ApiError(404,'EMAIL_NOT_FOUND','Email receipt not found.');
 if(!['blocked','failed'].includes(e.status))throw new ApiError(409,'EMAIL_NO_RETRY','Only blocked or definitively failed emails can be retried. Accepted or uncertain messages are not automatically resent.');
 const row=e.recipient_role==='client'?(await c.query('SELECT email FROM users WHERE id=$1',[e.customer_id])).rows[0]:(await c.query('SELECT email FROM drivers WHERE public_id=$1',[e.driver_id])).rows[0];
 const recipient=String(row?.email??'').trim();if(!emailValid(recipient))throw new ApiError(409,'EMAIL_MISSING','Update the client/driver account with a valid email address first.');
 await c.query(`UPDATE mealcart_pallet_emails SET recipient=$2,status='queued',detail='Manually queued again by the office.' WHERE id=$1`,[id,recipient]);await c.query('COMMIT');return{id,status:'queued'};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}

import {pool} from '../db/pool.js';
import {localClock} from '../lib/delivery-events.js';
import {messaging as cfg} from '../config/delivery-messaging.js';
export const REMINDER_EVENT='Scheduled Delivery Reminder';
export function addDays(date:string,days:number){return new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);}
export function reminderDue(schedule:{daysBefore:number;sendTime:string},deliveryDate:string,now:Date){
 const clock=localClock(now,cfg.DELIVERY_TIMEZONE),parts=schedule.sendTime.split(':').map(Number);
 const intendedDate=addDays(deliveryDate,-schedule.daysBefore),intendedSeconds=parts[0]*3600+parts[1]*60;
 const difference=(Date.parse(clock.date+'T12:00:00Z')-Date.parse(intendedDate+'T12:00:00Z'))/1000+clock.seconds-intendedSeconds;
 return difference>=0&&difference<cfg.NOTIFICATION_GRACE_MINUTES*60;
}
// Timing belongs to the template. Group membership creates the automatic trigger.
// There is no separate schedule record or enable switch to configure.
const selection=`SELECT ('template:'||t.id||':'||g.id) AS id,g.id AS "groupId",t.id AS "templateId",t.name,t.channel,
 t.reminder_days_before AS "daysBefore",to_char(t.reminder_send_time,'HH24:MI') AS "sendTime",true AS enabled
 FROM mealcart_group_templates gt JOIN mealcart_message_templates t ON t.id=gt.template_id
 JOIN mealcart_customer_groups g ON g.id=gt.group_id
 WHERE t.event='Scheduled Delivery Reminder' AND t.status='Active' AND g.status='Active'
 AND t.channel IN ('SMS','Email')`;
export async function listReminderSchedules(){return(await pool.query(selection+' ORDER BY g.id,t.id')).rows;}
export async function reminderSchedule(key:string){return(await pool.query(selection+" AND ('template:'||t.id||':'||g.id)=$1",[key])).rows[0]??null;}

import {randomUUID} from 'node:crypto';
import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
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
const selection=`SELECT id,group_id AS "groupId",template_id AS "templateId",name,days_before AS "daysBefore",to_char(send_time,'HH24:MI') AS "sendTime",enabled,version FROM mealcart_delivery_reminder_schedules`;
export async function listReminderSchedules(){return(await pool.query(selection+' ORDER BY group_id,days_before DESC,send_time,id')).rows;}
export async function reminderSchedule(id:string){return(await pool.query(selection+' WHERE id=$1',[id])).rows[0]??null;}
export interface ReminderInput{groupId:string;templateId:string;name:string;daysBefore:number;sendTime:string;enabled:boolean;version?:number}
export async function saveReminderSchedule(input:ReminderInput,id?:string){
 const c=await pool.connect();try{await c.query('BEGIN');
  // Same lock as group/template edits: a schedule cannot race a template assignment change.
  await c.query('SELECT pg_advisory_xact_lock(740321,2)');
  const template=(await c.query(`SELECT t.id FROM mealcart_message_templates t JOIN mealcart_group_templates gt ON gt.template_id=t.id WHERE gt.group_id=$1 AND t.id=$2 AND t.event=$3`,[input.groupId,input.templateId,REMINDER_EVENT])).rows[0];
  if(!template)throw new ApiError(409,'TEMPLATE_ASSIGNMENT_REQUIRED','Assign a Scheduled Delivery Reminder template to this group first');
  if(id){const old=(await c.query('SELECT * FROM mealcart_delivery_reminder_schedules WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!old||old.version!==input.version)throw new ApiError(409,'SCHEDULE_CHANGED','This reminder changed. Refresh and try again');if(old.group_id!==input.groupId||old.template_id!==input.templateId)throw new ApiError(409,'SCHEDULE_IDENTITY_CHANGED','Keep the group/template for this reminder. Create a new reminder for another group/template');}
  const values=[id??randomUUID(),input.groupId,input.templateId,input.name,input.daysBefore,input.sendTime,input.enabled];
  await c.query(`INSERT INTO mealcart_delivery_reminder_schedules(id,group_id,template_id,name,days_before,send_time,enabled) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,days_before=EXCLUDED.days_before,send_time=EXCLUDED.send_time,enabled=EXCLUDED.enabled,version=mealcart_delivery_reminder_schedules.version+1,updated_at=clock_timestamp()`,values);
  await c.query('COMMIT');return reminderSchedule(values[0] as string);
 }catch(e){await c.query('ROLLBACK');if((e as {code?:string}).code==='23505')throw new ApiError(409,'DUPLICATE_REMINDER','This group/template already has a reminder at that day and time');throw e;}finally{c.release();}
}
export async function recipientSettings(){
 const settings=(await pool.query('SELECT recipient_name_column AS "nameColumn",recipient_phone_column AS "phoneColumn",recipient_email_column AS "emailColumn",version FROM mealcart_notification_settings WHERE id=1')).rows[0];
 if(!settings)throw new ApiError(503,'SETTINGS_REQUIRED','Run the flexible reminder SQL migration');return settings;
}
export async function recipientColumns(){return(await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='jobs' AND data_type IN ('text','character varying','character') ORDER BY ordinal_position`)).rows.map(r=>r.column_name as string);}
export async function saveRecipientSettings(input:{nameColumn:string;phoneColumn:string;emailColumn:string;version:number}){
 const columns=await recipientColumns();for(const value of [input.nameColumn,input.phoneColumn,input.emailColumn])if(value&&!columns.includes(value))throw new ApiError(400,'COLUMN_NOT_FOUND',`jobs.${value} is not a text column in this database`);
 const result=await pool.query(`UPDATE mealcart_notification_settings SET recipient_name_column=$1,recipient_phone_column=$2,recipient_email_column=$3,version=version+1,updated_at=clock_timestamp() WHERE id=1 AND version=$4 RETURNING id`,[input.nameColumn,input.phoneColumn,input.emailColumn,input.version]);
 if(!result.rowCount)throw new ApiError(409,'SETTINGS_CHANGED','Recipient settings changed. Refresh and try again');return recipientSettings();
}

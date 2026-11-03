import {ApiError} from '../types/api.types.js';
import {randomUUID} from 'node:crypto';
import {pool} from '../db/pool.js';
import {messaging as cfg} from '../config/delivery-messaging.js';
import {localClock,renderMessage,phoneE164} from '../lib/delivery-events.js';
import {sendNotification,ProviderFailure} from './notification-provider.service.js';
import {recipientSettings,reminderSchedule,listReminderSchedules,reminderDue,addDays,REMINDER_EVENT} from './reminder-schedule.service.js';
import {jobByDoNumber,routeJob,plannedJobs} from './job-notification-source.service.js';

export async function notificationContext(jobId:number,event:string,templateId?:string){
 const row=(await pool.query(`SELECT to_jsonb(j) AS job,u.id AS customer_id,u.role,u.status AS customer_status,g.id AS group_id,g.status AS group_status,g.preferred_contact
 FROM jobs j LEFT JOIN users u ON u.id::text=COALESCE(NULLIF(j.notification_customer_id::text,''),NULLIF(to_jsonb(j)->>$2,''))
 LEFT JOIN mealcart_group_members m ON m.user_id=u.id LEFT JOIN mealcart_customer_groups g ON g.id=m.group_id WHERE j.id=$1`,[jobId,cfg.NOTIFICATION_JOB_CUSTOMER_COLUMN])).rows;
 const job=row[0];if(row.length!==1||!job?.job.do_number)return{problem:'Source job has no unique delivery reference'};
 try{const matched=await jobByDoNumber(String(job.job.do_number));if(matched.id!==jobId)return{problem:'Job reference changed'};}catch(e){return{problem:(e as Error).message,job};}
 if(!job.customer_id||job.role!=='customer')return{problem:'Link this job to a customer account to select its group (contacts are read from jobs)',job};
 if(String(job.customer_status).toLowerCase()!=='active'||job.group_status!=='Active')return{problem:'Customer or group is inactive / unassigned',job};
 const templates=(await pool.query(`SELECT t.* FROM mealcart_message_templates t JOIN mealcart_group_templates gt ON gt.template_id=t.id WHERE gt.group_id=$1 AND t.event=$2 AND t.status='Active' AND t.channel IN ($3,'Both') AND ($4::text IS NULL OR t.id=$4) ORDER BY t.id`,[job.group_id,event,job.preferred_contact,templateId??null])).rows;
 if(templates.length!==1)return{problem:templates.length?'Multiple active templates match this group/event/channel; use one for this event':'No active matching assigned group template',job};
 const settings=await recipientSettings();
 job.recipient_name=String(job.job[settings.nameColumn]??'').trim();
 job.recipient_phone=String(job.job[settings.phoneColumn]??'').trim();
 job.recipient_email=settings.emailColumn?String(job.job[settings.emailColumn]??'').trim():'';
 let recipient='';try{recipient=job.preferred_contact==='SMS'?phoneE164(job.recipient_phone):job.recipient_email;if(job.preferred_contact==='Email'&&!settings.emailColumn)throw new Error('Select the jobs recipient-email column in Recipient fields before enabling email');if(job.preferred_contact==='Email'&&!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(recipient))throw new Error('Job recipient email is missing or invalid');}catch(error){return{problem:(error as Error).message,job};}
 return{job,template:templates[0],recipient,problem:''};
}
export async function liveJob(jobId:number,date:string){
 const source=(await pool.query('SELECT do_number FROM jobs WHERE id=$1',[jobId])).rows[0];if(!source?.do_number)return null;
 const rows=(await pool.query(`SELECT p.public_id,p.driver_id,d.name AS driver_name,s.value AS stop,e.eta_updated_at
 FROM route_plans p CROSS JOIN LATERAL jsonb_array_elements(p.stop_arrivals) s(value)
 LEFT JOIN drivers d ON d.public_id=p.driver_id
 LEFT JOIN mealcart_route_execution e ON e.plan_id=p.public_id AND e.plan_created_at=p.created_at::timestamptz
 WHERE p.status='Planned' AND p.plan_date=$1 AND (s.value->>'stopId' IN ($2,$3) OR s.value->>'do_number'=$2 OR s.value->>'doNumber'=$2 OR s.value->>'orderRef'=$2)`,[date,source.do_number,`STP-J${jobId}`])).rows;
 if(rows.length!==1)return null;try{const matched=await routeJob(rows[0].stop);return matched?.id===jobId?rows[0]:null;}catch{return null;}
}
type Eligible={problem:string;job?:any;template?:any;recipient?:string;live?:any;reason?:string;lead?:number|null;schedule?:any};
async function isEligible(jobId:number,event:string,date:string,now:Date,scheduleKey=''):Promise<Eligible>{
 let schedule:any=null;
 if(event===REMINDER_EVENT){if(!scheduleKey)return{problem:'A flexible reminder schedule is required'};schedule=await reminderSchedule(scheduleKey);if(!schedule?.enabled)return{problem:'Reminder disabled or removed'};if(!reminderDue(schedule,date,now))return{problem:'Reminder sending window expired or not yet due'};}
 else if(!['Delivery ETA — One Hour','Delivery Failed'].includes(event))return{problem:'Legacy event is not automated; use a flexible reminder schedule'};
 const c=await notificationContext(jobId,event,schedule?.templateId);if(c.problem||!c.job||!c.template)return{...c,problem:c.problem||'Template unavailable'};
 if(schedule&&schedule.groupId!==c.job.group_id)return{...c,problem:'Job is no longer in the reminder group'};
 const job=c.job.job;if(String(job.scheduled_date).slice(0,10)!==date)return{...c,problem:'Job delivery date changed'};
 const live=await liveJob(jobId,date);
 if(event==='Delivery Failed'){
  if(String(job.status).toLowerCase()!=='failed')return{...c,problem:'Job is no longer failed'};
  const failure=(await pool.query('SELECT reason FROM mealcart_delivery_failures WHERE job_id=$1 AND delivery_date=$2 ORDER BY received_at DESC LIMIT 1',[jobId,date])).rows[0];
  if(!failure)return{...c,problem:'No driver failure record'};
  return{...c,live,reason:failure.reason,lead:null};
 }
 if(['completed','failed','cancelled','canceled'].includes(String(job.status).toLowerCase()))return{...c,problem:'Job is no longer pending'};
 if(!live||live.stop.status!=='Pending')return{...c,problem:'No unique pending route-plan stop matches this job do_number'};
 if(schedule)return{...c,live,schedule,reason:'',lead:null};
 const clock=localClock(now,cfg.DELIVERY_TIMEZONE),age=live.eta_updated_at?now.getTime()-new Date(live.eta_updated_at).getTime():Infinity,lead=Number(live.stop.liveEtaSeconds)-clock.seconds;
 if(clock.date!==date||age<0||age>Math.max(cfg.ETA_REFRESH_SECONDS*2,600)*1000||!Number.isFinite(lead)||lead>3900||lead< -900)return{...c,problem:'No fresh live ETA in the one-hour notification window'};
 return{...c,live,reason:'',lead};
}
function messageData(c:Eligible,date:string){
 const job=c.job.job,arrival=Number(c.live?.stop.liveEtaSeconds),name=c.job.recipient_name||'Recipient';
 return{customer_name:name,recipient_name:name,recipient_phone:c.job.recipient_phone,recipient_email:c.job.recipient_email,order_id:String(job.do_number),driver_name:c.live?.driver_name??'Mealcart driver',delivery_date:date,estimated_arrival:Number.isFinite(arrival)?`${String(Math.floor(arrival/3600)%24).padStart(2,'0')}:${String(Math.floor(arrival/60)%60).padStart(2,'0')} (${cfg.DELIVERY_TIMEZONE})`:'To be confirmed',delivery_address:String(job.delivery_address??''),company_name:'Mealcart',failure_reason:String(c.reason??'')};
}
export async function enqueueNotice(jobId:number,date:string,event:string,now=new Date(),scheduleKey=''){
 const c=await isEligible(jobId,event,date,now,scheduleKey);if(c.problem)return c.problem;
 try{const vars=messageData(c,date);await pool.query(`INSERT INTO mealcart_delivery_messages(id,job_id,delivery_date,event,channel,customer_id,group_id,template_id,recipient,subject,body,lead_seconds,schedule_key,do_number,recipient_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'jobs') ON CONFLICT(job_id,delivery_date,event,channel,schedule_key) DO NOTHING`,[randomUUID(),jobId,date,event,c.job.preferred_contact,c.job.customer_id,c.job.group_id,c.template.id,c.recipient,renderMessage(c.template.subject,vars),renderMessage(c.template.body,vars),c.lead??null,scheduleKey,c.job.job.do_number]);return'';}catch(error){return(error as Error).message;}
}
export async function discoverNotices(now=new Date()){
 const clock=localClock(now,cfg.DELIVERY_TIMEZONE),schedules=await listReminderSchedules();
 const cache=new Map<string,{jobs:Awaited<ReturnType<typeof plannedJobs>>['jobs'];groups:Map<number,string>}>();
 const candidates=async(date:string)=>{if(!cache.has(date)){const planned=await plannedJobs(date);const ids=planned.jobs.map(j=>j.id);const rows=ids.length?(await pool.query(`SELECT j.id,m.group_id FROM jobs j JOIN users u ON u.id::text=COALESCE(NULLIF(j.notification_customer_id::text,''),NULLIF(to_jsonb(j)->>$2,'')) JOIN mealcart_group_members m ON m.user_id=u.id WHERE j.id=ANY($1::integer[])`,[ids,cfg.NOTIFICATION_JOB_CUSTOMER_COLUMN])).rows:[];cache.set(date,{jobs:planned.jobs,groups:new Map(rows.map(r=>[r.id,r.group_id]))});}return cache.get(date)!;};
 for(const schedule of schedules){if(!schedule.enabled)continue;
  // The previous local date handles a late-night send window crossing midnight.
  for(const base of [clock.date,addDays(clock.date,-1)]){const date=addDays(base,schedule.daysBefore);if(!reminderDue(schedule,date,now))continue;const result=await candidates(date);for(const j of result.jobs)if(result.groups.get(j.id)===schedule.groupId)await enqueueNotice(j.id,date,REMINDER_EVENT,now,schedule.id);}
 }
 // Filter in SQL first: idle routes and distant deliveries need no per-job lookup each minute.
 const dueEtas=(await pool.query(`SELECT s.value AS stop FROM route_plans p JOIN mealcart_route_execution e ON e.plan_id=p.public_id AND e.plan_created_at=p.created_at::timestamptz CROSS JOIN LATERAL jsonb_array_elements(p.stop_arrivals) s(value) WHERE p.status='Planned' AND p.plan_date=$1 AND e.eta_updated_at>$2::timestamptz-($3*interval '1 second') AND s.value->>'status'='Pending' AND (s.value->>'liveEtaSeconds')::numeric BETWEEN $4 AND $5`,[clock.date,now.toISOString(),Math.max(cfg.ETA_REFRESH_SECONDS*2,600),clock.seconds-900,clock.seconds+3900])).rows;
 for(const row of dueEtas){try{const j=await routeJob(row.stop);if(j)await enqueueNotice(j.id,clock.date,'Delivery ETA — One Hour',now);}catch{/* Ambiguous references are reported by the admin readiness check; never guess. */}}
 const failures=(await pool.query(`SELECT DISTINCT f.job_id,j.scheduled_date::text AS date FROM mealcart_delivery_failures f JOIN jobs j ON j.id=f.job_id WHERE f.received_at>$1::timestamptz-interval '24 hours' AND lower(j.status)='failed' AND f.delivery_date=j.scheduled_date`,[now.toISOString()])).rows;
 for(const j of failures)await enqueueNotice(j.job_id,j.date,'Delivery Failed',now);
}
export async function dispatchNotices(now?:Date){
 await pool.query(`UPDATE mealcart_delivery_messages SET status='unknown',detail='Worker stopped during submission; check provider before any resend' WHERE status='sending' AND attempted_at<$1::timestamptz-interval '5 minutes'`,[(now??new Date()).toISOString()]);
 const rows=(await pool.query(`SELECT *,delivery_date::text AS delivery_date FROM mealcart_delivery_messages WHERE status IN ('queued','blocked') ORDER BY created_at LIMIT 50`)).rows;
 for(const row of rows){
  const sendAt=now??new Date(),date=String(row.delivery_date).slice(0,10),context=await isEligible(row.job_id,row.event,date,sendAt,row.schedule_key);
  if(row.recipient_source!=='jobs'||context.problem||context.template?.id!==row.template_id||context.job?.job.do_number!==row.do_number||context.job?.preferred_contact!==row.channel||context.recipient!==row.recipient||context.job?.group_id!==row.group_id){await pool.query(`UPDATE mealcart_delivery_messages SET status='cancelled',detail=$2 WHERE id=$1`,[row.id,context.problem||'Job recipient, reference, group or template changed; cancelled for review']);continue;}
  const vars=messageData(context,date);let subject:string,body:string;try{subject=renderMessage(context.template.subject,vars);body=renderMessage(context.template.body,vars);}catch(error){await pool.query("UPDATE mealcart_delivery_messages SET status='blocked',detail=$2 WHERE id=$1",[row.id,(error as Error).message]);continue;}
  const claim=await pool.query(`UPDATE mealcart_delivery_messages SET status='sending',attempted_at=$2,subject=$3,body=$4,lead_seconds=$5,detail='' WHERE id=$1 AND status IN ('queued','blocked') RETURNING id`,[row.id,sendAt.toISOString(),subject,body,context.lead??null]);if(!claim.rowCount)continue;
  try{const providerId=await sendNotification({...row,subject,body});await pool.query(`UPDATE mealcart_delivery_messages SET status='accepted',provider_id=$2,accepted_at=clock_timestamp(),detail='Provider accepted; this is not a confirmed delivery receipt' WHERE id=$1`,[row.id,providerId]);}catch(error){const e=error instanceof ProviderFailure?error:new ProviderFailure('unknown','Unexpected provider interruption; check provider console');await pool.query('UPDATE mealcart_delivery_messages SET status=$2,detail=$3 WHERE id=$1',[row.id,e.disposition,e.message]);}
 }
}
export async function retryNotification(id:string){
 const row=(await pool.query('SELECT *,delivery_date::text AS delivery_date FROM mealcart_delivery_messages WHERE id=$1',[id])).rows[0];
 if(!row||row.recipient_source!=='jobs'||!['failed','blocked','cancelled'].includes(row.status))throw new ApiError(409,'NO_SAFE_RETRY','Only current-job rejected, blocked or cancelled messages can be retried. Accepted, uncertain or legacy sends require review');
 const c=await isEligible(row.job_id,row.event,row.delivery_date,new Date(),row.schedule_key);if(c.problem||!c.template||!c.job||c.job.preferred_contact!==row.channel)throw new ApiError(409,'NOT_READY',c.problem||'Message channel changed; review the current preferred-channel message instead');
 await pool.query("UPDATE mealcart_delivery_messages SET status='queued',detail='Staff requested safe retry',customer_id=$2,group_id=$3,template_id=$4,recipient=$5,do_number=$6 WHERE id=$1 AND status IN ('failed','blocked','cancelled')",[id,c.job.customer_id,c.job.group_id,c.template.id,c.recipient,c.job.job.do_number]);return{id};
}

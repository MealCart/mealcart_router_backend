import {getOrCreateTrackingLink} from './customer-tracking.service.js';
import {ApiError} from '../types/api.types.js';
import {randomUUID} from 'node:crypto';
import {pool} from '../db/pool.js';
import {messaging as cfg} from '../config/delivery-messaging.js';
import {localClock,renderMessage,phoneE164} from '../lib/delivery-events.js';
import {sendNotification,ProviderFailure} from './notification-provider.service.js';
import {reminderSchedule,listReminderSchedules,reminderDue,addDays,REMINDER_EVENT} from './reminder-schedule.service.js';
import {jobByDoNumber,routeNotificationSource,plannedJobs,type NotificationSource} from './job-notification-source.service.js';

export const DAILY_EVENT = 'Daily Schedule Update';
export const notificationChannels = ['SMS', 'Email'] as const;
type NotificationChannel = typeof notificationChannels[number];

export async function notificationContext(
 jobId:number,event:string,templateId?:string,channel:NotificationChannel='SMS',source:NotificationSource='jobs',
){
 const table=source==='collections'?'collections':'jobs';
 const rows=(await pool.query(`SELECT to_jsonb(j) AS job,j.user_id AS customer_id,g.id AS group_id,g.status AS group_status
 FROM ${table} j LEFT JOIN mealcart_group_members m ON m.user_id::text=j.user_id::text
 LEFT JOIN mealcart_customer_groups g ON g.id=m.group_id WHERE j.id=$1`,[jobId])).rows;
 const job=rows[0];
 if(rows.length!==1||!job?.job.do_number)return{problem:'Source record or group assignment is ambiguous'};
 if(source==='jobs'){
  const matched=await jobByDoNumber(String(job.job.do_number)).catch(()=>null);
  if(matched?.id!==jobId)return{problem:'Delivery reference is ambiguous or changed',job};
 }
 if(!job.customer_id||job.group_status!=='Active')return{problem:'Source user has no active customer group',job};
 const templates=(await pool.query(`SELECT t.* FROM mealcart_message_templates t JOIN mealcart_group_templates gt ON gt.template_id=t.id
 WHERE gt.group_id=$1 AND t.event=$2 AND t.status='Active' AND t.channel=$3 AND ($4::text IS NULL OR t.id=$4)`,[job.group_id,event,channel,templateId??null])).rows;
 if(templates.length!==1)return{problem:templates.length?'Multiple assigned templates match this event and channel':'No active assigned template for this event and channel',job};
 job.source_kind=source;
 job.recipient_name=String(job.job.recipient_name??'').trim();
 // Current bookings use recipient_phone. Older records may use recipient_phon.
 job.recipient_phone=String(job.job.recipient_phone??'').trim()||String(job.job.recipient_phon??'').trim();
 job.recipient_email=String(job.job.recipient_email??'').trim();
 try{
  const recipient=channel==='SMS'?phoneE164(job.recipient_phone):job.recipient_email;
  if(channel==='Email'&&!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(recipient))throw new Error('Recipient email is missing or invalid');
  return{job,template:templates[0],recipient,problem:''};
 }catch(error){return{problem:(error as Error).message,job};}
}
export async function liveJob(jobId:number,date:string,kind:NotificationSource='jobs'){
 const table=kind==='collections'?'collections':'jobs';
 const source=(await pool.query(`SELECT do_number FROM ${table} WHERE id=$1`,[jobId])).rows[0];
 if(!source?.do_number)return null;
 const rows=(await pool.query(`SELECT p.public_id,p.driver_id,d.name AS driver_name,s.value AS stop,e.eta_updated_at
 FROM route_plans p CROSS JOIN LATERAL jsonb_array_elements(p.stop_arrivals) s(value)
 LEFT JOIN drivers d ON d.public_id=p.driver_id
 LEFT JOIN mealcart_route_execution e ON e.plan_id=p.public_id AND e.plan_created_at=p.created_at::timestamptz
 WHERE p.status='Planned' AND p.plan_date=$1 AND
 (s.value->>'stopId'=$3 OR ($4='jobs' AND s.value->>'stopId' NOT LIKE 'STP-C%' AND
 (s.value->>'stopId'=$2 OR s.value->>'do_number'=$2 OR s.value->>'doNumber'=$2 OR s.value->>'orderRef'=$2)))`,
 [date,source.do_number,`STP-${kind==='jobs'?'J':'C'}${jobId}`,kind])).rows;
 if(rows.length!==1)return null;
 try{const matched=await routeNotificationSource(rows[0].stop);return matched?.kind===kind&&matched.id===jobId?rows[0]:null;}catch{return null;}
}
type Eligible={problem:string;job?:any;template?:any;recipient?:string;live?:any;reason?:string;lead?:number|null;schedule?:any;completion?:any};
async function isEligible(jobId:number,event:string,date:string,now:Date,scheduleKey='',channel:NotificationChannel='SMS',source:NotificationSource='jobs'):Promise<Eligible>{
 let schedule:any=null;
 if(event===REMINDER_EVENT){if(!scheduleKey)return{problem:'Template timing reference is required'};schedule=await reminderSchedule(scheduleKey);if(!schedule?.enabled||schedule.channel!==channel)return{problem:'Reminder template is inactive or no longer selected for this group'};if(!reminderDue(schedule,date,now))return{problem:'Reminder sending window expired or not yet due'};}
 else if(![DAILY_EVENT,'Delivery ETA — One Hour','Delivery Failed','Delivery Completed'].includes(event))return{problem:'Legacy event is not automated; use a flexible reminder schedule'};
 const c=await notificationContext(jobId,event,schedule?.templateId,channel,source);if(c.problem||!c.job||!c.template)return{...c,problem:c.problem||'Template unavailable'};
 if(schedule&&schedule.groupId!==c.job.group_id)return{...c,problem:'Job is no longer in the reminder group'};
 const job=c.job.job;if(["cancelled","canceled"].includes(String(job.status).toLowerCase()))return{...c,problem:"Source order was cancelled"};if(String(job.scheduled_date).slice(0,10)!==date)return{...c,problem:'Job delivery date changed'};
 if(event==='Delivery Completed'){
  if(source==='jobs'&&String(job.status).toLowerCase()!=='completed')return{...c,problem:'Job is not completed'};
  const completion=(await pool.query(`SELECT * FROM mealcart_completed_delivery_events WHERE job_id=$1 AND delivery_date=$2 AND do_number=$3 AND source_kind=$5 AND created_at>$4::timestamptz-interval '24 hours' ORDER BY created_at DESC LIMIT 1`,[jobId,date,job.do_number,now.toISOString(),source])).rows[0];
  if(!completion)return{...c,problem:'No new verified delivery completion event in the sending window'};
  return{...c,completion,reason:'',lead:null};
 }
 const live=await liveJob(jobId,date,source);
 if(event===DAILY_EVENT){
  if(['completed','failed','cancelled','canceled'].includes(String(job.status).toLowerCase()))return{...c,problem:'Order is no longer pending'};
  const clock=localClock(now,cfg.DELIVERY_TIMEZONE);
  const sendTime=String(c.template.reminder_send_time??'').slice(0,5);
  if(clock.date!==date||!sendTime||!reminderDue({daysBefore:0,sendTime},date,now))return{...c,problem:'Daily update is outside its sending window'};
  if(live&&live.stop.status!=='Pending')return{...c,problem:'Route stop is no longer pending'};
  const ended=await pool.query(`SELECT 1 FROM mealcart_completed_delivery_events
    WHERE source_kind=$1 AND job_id=$2 AND delivery_date=$3 AND do_number=$4
   UNION ALL SELECT 1 FROM mealcart_delivery_failures
    WHERE source_kind=$1 AND job_id=$2 AND delivery_date=$3 AND (do_number=$4 OR (do_number IS NULL AND source_kind='jobs'))
   LIMIT 1`,[source,jobId,date,job.do_number]);
  if(ended.rows.length)return{...c,problem:'This order was already completed or failed'};
  return{...c,live,reason:'',lead:null};
 }

 if(event==='Delivery Failed'){
  if(source==='jobs'&&String(job.status).toLowerCase()!=='failed')return{...c,problem:'Job is no longer failed'};
  const failure=(await pool.query(`SELECT reason FROM mealcart_delivery_failures WHERE job_id=$1 AND delivery_date=$2 AND source_kind=$3 AND (do_number=$4 OR (do_number IS NULL AND source_kind='jobs')) AND received_at>$5::timestamptz-interval '24 hours' ORDER BY received_at DESC LIMIT 1`,[jobId,date,source,job.do_number,now.toISOString()])).rows[0];
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
 return{tracking_link:"{{tracking_link}}",customer_name:name,recipient_name:name,recipient_phone:c.job.recipient_phone,recipient_email:c.job.recipient_email,order_id:String(job.do_number),driver_name:c.completion?.driver_name??c.live?.driver_name??'Mealcart driver',delivery_date:date,estimated_arrival:Number.isFinite(arrival)?`${String(Math.floor(arrival/3600)%24).padStart(2,'0')}:${String(Math.floor(arrival/60)%60).padStart(2,'0')} (${cfg.DELIVERY_TIMEZONE})`:'To be confirmed',service_type:c.job.source_kind==='collections'?'collection':'delivery',delivery_address:String(job.delivery_address??job.collection_address??''),company_name:'Mealcart',failure_reason:String(c.reason??''),completed_at:c.completion?new Intl.DateTimeFormat('en-AU',{timeZone:cfg.DELIVERY_TIMEZONE,dateStyle:'medium',timeStyle:'short'}).format(new Date(c.completion.completed_at))+' ('+cfg.DELIVERY_TIMEZONE+')':''};
}
export async function enqueueNotice(jobId:number,date:string,event:string,now=new Date(),scheduleKey='',channel:NotificationChannel='SMS',source:NotificationSource='jobs'){
 if(event===DAILY_EVENT)scheduleKey='daily';
 const c=await isEligible(jobId,event,date,now,scheduleKey,channel,source);if(c.problem)return c.problem;
 if(event===REMINDER_EVENT){const previous=await pool.query(`SELECT 1 FROM mealcart_delivery_messages m WHERE m.source_kind=$7 AND m.job_id=$1 AND m.delivery_date=$2 AND m.channel=$3 AND m.group_id=$4 AND m.event=$5 AND m.status IN ('accepted','unknown','sending') AND (m.template_id=$6 OR m.schedule_key IN (SELECT old_schedule_id FROM mealcart_reminder_legacy_links WHERE (template_id=$6 OR ($3='Email' AND 'TPL-'||md5('email:'||template_id)=$6)) AND group_id=$4)) LIMIT 1`,[jobId,date,channel,c.job.group_id,event,c.template.id,source]);if(previous.rows.length)return '';}
 try{const vars=messageData(c,date);await pool.query(`INSERT INTO mealcart_delivery_messages(id,job_id,delivery_date,event,channel,customer_id,group_id,template_id,recipient,subject,body,lead_seconds,schedule_key,do_number,recipient_source,source_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) ON CONFLICT(source_kind,job_id,delivery_date,event,channel,schedule_key) DO UPDATE SET recipient=EXCLUDED.recipient,subject=EXCLUDED.subject,body=EXCLUDED.body,customer_id=EXCLUDED.customer_id,group_id=EXCLUDED.group_id,template_id=EXCLUDED.template_id,do_number=EXCLUDED.do_number,status='queued',detail='Reminder is eligible after template/group changes',attempted_at=NULL WHERE mealcart_delivery_messages.status='cancelled' AND EXCLUDED.event IN ('Scheduled Delivery Reminder','Daily Schedule Update') AND mealcart_delivery_messages.recipient_source=EXCLUDED.source_kind`,[randomUUID(),jobId,date,event,channel,c.job.customer_id,c.job.group_id,c.template.id,c.recipient,renderMessage(c.template.subject,vars),renderMessage(c.template.body,vars),c.lead??null,scheduleKey,c.job.job.do_number,source]);return'';}catch(error){return(error as Error).message;}
}
export async function discoverNotices(now=new Date()){
 const clock=localClock(now,cfg.DELIVERY_TIMEZONE),schedules=await listReminderSchedules();
 const dailyTemplates=(await pool.query(`SELECT gt.group_id,t.channel,to_char(t.reminder_send_time,'HH24:MI') AS send_time
  FROM mealcart_group_templates gt JOIN mealcart_message_templates t ON t.id=gt.template_id
  JOIN mealcart_customer_groups g ON g.id=gt.group_id
  WHERE t.event=$1 AND t.status='Active' AND g.status='Active'`,[DAILY_EVENT])).rows;
 for(const daily of dailyTemplates){
  if(!reminderDue({daysBefore:0,sendTime:daily.send_time},clock.date,now))continue;
  for(const kind of ['jobs','collections'] as const){
   const table=kind==='jobs'?'jobs':'collections';
   const records=(await pool.query(`SELECT j.id FROM ${table} j
    JOIN mealcart_group_members m ON m.user_id::text=j.user_id::text
    WHERE m.group_id=$1 AND j.scheduled_date=$2
     AND lower(COALESCE(j.status,'')) NOT IN ('completed','failed','cancelled','canceled')
     AND NOT EXISTS(SELECT 1 FROM mealcart_delivery_messages sent
      WHERE sent.source_kind=$3 AND sent.job_id=j.id AND sent.delivery_date=$2
       AND sent.event=$4 AND sent.channel=$5 AND sent.schedule_key='daily'
       AND sent.status<>'cancelled')`,
    [daily.group_id,clock.date,kind,DAILY_EVENT,daily.channel])).rows;
   for(const record of records)await enqueueNotice(record.id,clock.date,DAILY_EVENT,now,'daily',daily.channel,kind);
  }
 }
 type Candidate=Awaited<ReturnType<typeof plannedJobs>>['jobs'][number];
 const cache=new Map<string,Map<string,Candidate[]>>();
 const candidates=async(date:string,groupId:string)=>{
  if(!cache.has(date)){
   const {jobs:records}=await plannedJobs(date);
   const groups=new Map<string,Candidate[]>();
   for(const kind of ['jobs','collections'] as const){
    const byId=new Map(records.filter(record=>record.kind===kind).map(record=>[record.id,record]));
    if(!byId.size)continue;
    const table=kind==='jobs'?'jobs':'collections';
    const {rows}=await pool.query(`SELECT j.id,m.group_id FROM ${table} j
     JOIN mealcart_group_members m ON m.user_id::text=j.user_id::text WHERE j.id=ANY($1::integer[])`,[[...byId.keys()]]);
    for(const row of rows){
     const group=groups.get(row.group_id)??[];
     group.push(byId.get(row.id)!);
     groups.set(row.group_id,group);
    }
   }
   cache.set(date,groups);
  }
  return cache.get(date)?.get(groupId)??[];
 };
 for(const schedule of schedules){if(!schedule.enabled)continue;
  // The previous local date handles a late-night send window crossing midnight.
  for(const base of [clock.date,addDays(clock.date,-1)]){const date=addDays(base,schedule.daysBefore);if(!reminderDue(schedule,date,now))continue;for(const j of await candidates(date,schedule.groupId))await enqueueNotice(j.id,date,REMINDER_EVENT,now,schedule.id,schedule.channel,j.kind);}
 }
 // Filter in SQL first: idle routes and distant deliveries need no per-job lookup each minute.
 const dueEtas=(await pool.query(`SELECT s.value AS stop FROM route_plans p JOIN mealcart_route_execution e ON e.plan_id=p.public_id AND e.plan_created_at=p.created_at::timestamptz CROSS JOIN LATERAL jsonb_array_elements(p.stop_arrivals) s(value) WHERE p.status='Planned' AND p.plan_date=$1 AND e.eta_updated_at>$2::timestamptz-($3*interval '1 second') AND s.value->>'status'='Pending' AND (s.value->>'liveEtaSeconds')::numeric BETWEEN $4 AND $5`,[clock.date,now.toISOString(),Math.max(cfg.ETA_REFRESH_SECONDS*2,600),clock.seconds-900,clock.seconds+3900])).rows;
 for(const row of dueEtas){
  const record=await routeNotificationSource(row.stop).catch(()=>null);
  if(record)for(const channel of notificationChannels)await enqueueNotice(record.id,clock.date,'Delivery ETA — One Hour',now,'',channel,record.kind);
 }
 const events=[
  {event:'Delivery Failed',table:'mealcart_delivery_failures',time:'received_at'},
  {event:'Delivery Completed',table:'mealcart_completed_delivery_events',time:'created_at'},
 ];
 for(const {event,table,time} of events){
  const due=(await pool.query(`SELECT DISTINCT e.source_kind,e.job_id,e.delivery_date::text AS date,c.channel
   FROM ${table} e CROSS JOIN (VALUES ('SMS'),('Email')) c(channel)
   WHERE e.${time}>$1::timestamptz-interval '24 hours'
   AND NOT EXISTS(SELECT 1 FROM mealcart_delivery_messages m WHERE m.source_kind=e.source_kind AND m.job_id=e.job_id
    AND m.delivery_date=e.delivery_date AND m.event=$2 AND m.channel=c.channel)`,[now.toISOString(),event])).rows;
  for(const row of due)await enqueueNotice(row.job_id,row.date,event,now,'',row.channel,row.source_kind);
 }
}
export async function dispatchNotices(now?:Date){
 await pool.query(`UPDATE mealcart_delivery_messages SET status='unknown',detail='Worker stopped during submission; check provider before any resend' WHERE status='sending' AND attempted_at<$1::timestamptz-interval '5 minutes'`,[(now??new Date()).toISOString()]);
 const rows=(await pool.query(`SELECT *,delivery_date::text AS delivery_date FROM mealcart_delivery_messages WHERE status IN ('queued','blocked') ORDER BY created_at LIMIT 50`)).rows;
 for(const row of rows){
  const sendAt=now??new Date(),date=String(row.delivery_date).slice(0,10),context=await isEligible(row.job_id,row.event,date,sendAt,row.schedule_key,row.channel,row.source_kind);
  if(row.recipient_source!==row.source_kind||context.problem||context.template?.id!==row.template_id||context.job?.job.do_number!==row.do_number||context.recipient!==row.recipient||context.job?.group_id!==row.group_id){await pool.query(`UPDATE mealcart_delivery_messages SET status='cancelled',detail=$2 WHERE id=$1`,[row.id,context.problem||'Job recipient, reference, group or template changed; cancelled for review']);continue;}
  let subject:string,body:string;try{
   const vars=messageData(context,date);
   if(/\{\{\s*tracking_link\s*\}\}/.test(context.template.subject+' '+context.template.body)){
    vars.tracking_link=await getOrCreateTrackingLink({source:row.source_kind,id:row.job_id,reference:context.job.job.do_number,customerId:String(context.job.customer_id),recipientPhone:context.job.recipient_phone,recipientEmail:context.job.recipient_email,date},sendAt);
   }
   subject=renderMessage(context.template.subject,vars);body=renderMessage(context.template.body,vars);}catch(error){await pool.query("UPDATE mealcart_delivery_messages SET status='blocked',detail=$2 WHERE id=$1",[row.id,(error as Error).message]);continue;}
  const claim=await pool.query(`UPDATE mealcart_delivery_messages SET status='sending',attempted_at=$2,subject=$3,body=$4,lead_seconds=$5,detail='' WHERE id=$1 AND status IN ('queued','blocked') RETURNING id`,[row.id,sendAt.toISOString(),subject,body,context.lead??null]);if(!claim.rowCount)continue;
  try{const providerId=await sendNotification({...row,subject,body});await pool.query(`UPDATE mealcart_delivery_messages SET status='accepted',provider_id=$2,accepted_at=clock_timestamp(),detail='Provider accepted; this is not a confirmed delivery receipt' WHERE id=$1`,[row.id,providerId]);}catch(error){const e=error instanceof ProviderFailure?error:new ProviderFailure('unknown','Unexpected provider interruption; check provider console');await pool.query('UPDATE mealcart_delivery_messages SET status=$2,detail=$3 WHERE id=$1',[row.id,e.disposition,e.message]);}
 }
}
export async function retryNotification(id:string){
 const row=(await pool.query('SELECT *,delivery_date::text AS delivery_date FROM mealcart_delivery_messages WHERE id=$1',[id])).rows[0];
 if(!row||row.recipient_source!==row.source_kind||!['failed','blocked','cancelled'].includes(row.status))throw new ApiError(409,'NO_SAFE_RETRY','Only current-job rejected, blocked or cancelled messages can be retried. Accepted, uncertain or legacy sends require review');
 const c=await isEligible(row.job_id,row.event,row.delivery_date,new Date(),row.schedule_key,row.channel,row.source_kind);if(c.problem||!c.template||!c.job)throw new ApiError(409,'NOT_READY',c.problem||'The assigned message template is unavailable');
 await pool.query("UPDATE mealcart_delivery_messages SET status='queued',detail='Staff requested safe retry',customer_id=$2,group_id=$3,template_id=$4,recipient=$5,do_number=$6 WHERE id=$1 AND status IN ('failed','blocked','cancelled')",[id,c.job.customer_id,c.job.group_id,c.template.id,c.recipient,c.job.job.do_number]);return{id};
}

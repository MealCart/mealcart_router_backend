import {plannedJobs} from '../services/job-notification-source.service.js';
import {REMINDER_EVENT,listReminderSchedules,saveReminderSchedule,recipientSettings,recipientColumns,saveRecipientSettings} from '../services/reminder-schedule.service.js';
import {Router} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../utils/async-handler.js';
import {validateBody} from '../middleware/validate.middleware.js';
import {ApiError} from '../types/api.types.js';
import {pool} from '../db/pool.js';
import {messaging} from '../config/delivery-messaging.js';
import {scheduledEvents} from '../lib/delivery-events.js';
import {notificationContext,retryNotification} from '../services/delivery-notification.service.js';
import {routeExecution,startRouteExecution,stopRouteExecution,failDriverStop} from '../services/driver-execution.service.js';
export const mobileExecutionRouter=Router();
mobileExecutionRouter.get('/routes/:id/execution',asyncHandler(async(req,res)=>res.json({ok:true,data:await routeExecution(res.locals.driver.id,req.params.id)})));
mobileExecutionRouter.post('/routes/:id/start',validateBody(z.object({planCreatedAt:z.string().datetime({offset:true})}).strict()),asyncHandler(async(req,res)=>res.json({ok:true,data:await startRouteExecution(res.locals.driver.id,req.params.id,req.body.planCreatedAt)})));
mobileExecutionRouter.post('/routes/:id/end',asyncHandler(async(req,res)=>res.json({ok:true,data:await stopRouteExecution(res.locals.driver.id,req.params.id)})));
const failure=z.object({requestId:z.string().uuid(),planCreatedAt:z.string().datetime({offset:true}),stopId:z.string().regex(/^STP-J[1-9]\d*$/),reason:z.string().trim().min(3).max(2000),recordedAt:z.string().datetime({offset:true})}).strict();
mobileExecutionRouter.post('/routes/:id/stops/:seq/fail',validateBody(failure),asyncHandler(async(req,res)=>{const seq=Number(req.params.seq);if(!Number.isSafeInteger(seq)||seq<1)throw new ApiError(400,'BAD_SEQ','Invalid stop sequence');res.json({ok:true,data:await failDriverStop(res.locals.driver.id,req.params.id,seq,req.body)});}));
export const adminMessagingRouter=Router();
adminMessagingRouter.get('/delivery-messaging',asyncHandler(async(_req,res)=>{
 const messages=(await pool.query('SELECT id,job_id,do_number,schedule_key,recipient_source,delivery_date::text,event,channel,status,detail,provider_id,lead_seconds,created_at,accepted_at FROM mealcart_delivery_messages ORDER BY created_at DESC LIMIT 100')).rows;
 const health=(await pool.query('SELECT * FROM mealcart_notification_worker_health WHERE id=1')).rows[0]??null;
 const executions=(await pool.query('SELECT plan_id,driver_id,started_at,eta_updated_at,last_error,request_count FROM mealcart_route_execution WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 100')).rows;
 res.json({ok:true,data:{enabled:messaging.NOTIFICATIONS_ENABLED,timeZone:messaging.DELIVERY_TIMEZONE,events:scheduledEvents,messages,health,executions,schedules:await listReminderSchedules(),recipientSettings:await recipientSettings(),recipientColumns:await recipientColumns()}});
}));
adminMessagingRouter.get('/delivery-messaging/jobs',asyncHandler(async(req,res)=>{
 const date=String(req.query.date??'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new ApiError(400,'BAD_DATE','Use YYYY-MM-DD');
 const planned=await plannedJobs(date);
 const schedules=await listReminderSchedules();const result=[];
 for(const source of planned.jobs){const j=(await pool.query('SELECT id,do_number,notification_customer_id FROM jobs WHERE do_number=$1',[source.doNumber])).rows[0];const checks=[];
  for(const event of scheduledEvents){
   if(event===REMINDER_EVENT){const choices=schedules.filter(s=>s.enabled);let found=false;for(const schedule of choices){const c=await notificationContext(j.id,event,schedule.templateId);if(c.job?.group_id!==schedule.groupId)continue;found=true;checks.push({event:`${schedule.name} · ${schedule.daysBefore} day(s) before · ${schedule.sendTime}`,problem:c.problem||'',group:c.job?.group_id,channel:c.job?.preferred_contact});}if(!found)checks.push({event,problem:'No enabled reminder schedule for this job group'});
   }else{const c=await notificationContext(j.id,event);checks.push({event,problem:c.problem||'',group:c.job?.group_id??null,channel:c.job?.preferred_contact??null});}
  }
  result.push({...j,planId:source.planId,recipientName:'Job recipient',checks});
 }
 res.json({ok:true,data:{jobs:result,issues:planned.issues}});
}));
adminMessagingRouter.put('/delivery-messaging/jobs/:id/customer',validateBody(z.object({customerId:z.number().int().positive().max(2147483647)}).strict()),asyncHandler(async(req,res)=>{
 const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw new ApiError(400,'BAD_JOB','Invalid job');
 const result=await pool.query("UPDATE jobs SET notification_customer_id=$2 WHERE id=$1 AND EXISTS(SELECT 1 FROM users WHERE id=$2 AND role='customer') RETURNING id",[id,req.body.customerId]);if(!result.rowCount)throw new ApiError(404,'NOT_FOUND','Job or customer unavailable');res.json({ok:true,data:{id,customerId:req.body.customerId}});
}));

adminMessagingRouter.post('/delivery-messaging/:id/retry',asyncHandler(async(req,res)=>{if(!z.string().uuid().safeParse(req.params.id).success)throw new ApiError(400,'BAD_ID','Invalid message ID');res.json({ok:true,data:await retryNotification(req.params.id)});}));

const reminderBody=z.object({groupId:z.string().min(1).max(40),templateId:z.string().min(1).max(40),name:z.string().trim().min(1).max(120),daysBefore:z.number().int().min(0).max(60),sendTime:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),enabled:z.boolean()}).strict();
adminMessagingRouter.post('/delivery-messaging/schedules',validateBody(reminderBody),asyncHandler(async(req,res)=>res.json({ok:true,data:await saveReminderSchedule(req.body)})));
adminMessagingRouter.put('/delivery-messaging/schedules/:id',validateBody(reminderBody.extend({version:z.number().int().positive()})),asyncHandler(async(req,res)=>{if(!z.string().uuid().safeParse(req.params.id).success)throw new ApiError(400,'BAD_ID','Invalid reminder ID');res.json({ok:true,data:await saveReminderSchedule(req.body,req.params.id)});}));
const column=z.string().regex(/^[a-z_][a-z0-9_]*$/).max(63);
adminMessagingRouter.put('/delivery-messaging/recipient-settings',validateBody(z.object({nameColumn:column,phoneColumn:column,emailColumn:z.union([column,z.literal('')]),version:z.number().int().positive()}).strict()),asyncHandler(async(req,res)=>res.json({ok:true,data:await saveRecipientSettings(req.body)})));

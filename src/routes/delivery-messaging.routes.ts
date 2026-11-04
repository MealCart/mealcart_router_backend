import {plannedJobs} from '../services/job-notification-source.service.js';
import {REMINDER_EVENT,listReminderSchedules} from '../services/reminder-schedule.service.js';
import {Router} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../utils/async-handler.js';
import {validateBody} from '../middleware/validate.middleware.js';
import {ApiError} from '../types/api.types.js';
import {pool} from '../db/pool.js';
import {messaging} from '../config/delivery-messaging.js';
import {scheduledEvents} from '../lib/delivery-events.js';
import {notificationChannels,notificationContext,retryNotification} from '../services/delivery-notification.service.js';
import {routeExecution,startRouteExecution,stopRouteExecution,failDriverStop} from '../services/driver-execution.service.js';
export const mobileExecutionRouter=Router();
mobileExecutionRouter.get('/routes/:id/execution',asyncHandler(async(req,res)=>res.json({ok:true,data:await routeExecution(res.locals.driver.id,req.params.id)})));
mobileExecutionRouter.post('/routes/:id/start',validateBody(z.object({planCreatedAt:z.string().datetime({offset:true})}).strict()),asyncHandler(async(req,res)=>res.json({ok:true,data:await startRouteExecution(res.locals.driver.id,req.params.id,req.body.planCreatedAt)})));
mobileExecutionRouter.post('/routes/:id/end',asyncHandler(async(req,res)=>res.json({ok:true,data:await stopRouteExecution(res.locals.driver.id,req.params.id)})));
const failure=z.object({requestId:z.string().uuid(),planCreatedAt:z.string().datetime({offset:true}),stopId:z.string().regex(/^STP-[JC][1-9]\d*$/),reason:z.string().trim().min(3).max(2000),recordedAt:z.string().datetime({offset:true})}).strict();
mobileExecutionRouter.post('/routes/:id/stops/:seq/fail',validateBody(failure),asyncHandler(async(req,res)=>{const seq=Number(req.params.seq);if(!Number.isSafeInteger(seq)||seq<1)throw new ApiError(400,'BAD_SEQ','Invalid stop sequence');res.json({ok:true,data:await failDriverStop(res.locals.driver.id,req.params.id,seq,req.body)});}));
export const adminMessagingRouter=Router();
adminMessagingRouter.get('/delivery-messaging',asyncHandler(async(_req,res)=>{
 const messages=(await pool.query('SELECT id,job_id,do_number,schedule_key,recipient_source,source_kind,delivery_date::text,event,channel,status,detail,provider_id,lead_seconds,created_at,accepted_at FROM mealcart_delivery_messages ORDER BY created_at DESC LIMIT 100')).rows;
 const health=(await pool.query('SELECT * FROM mealcart_notification_worker_health WHERE id=1')).rows[0]??null;
 const executions=(await pool.query('SELECT plan_id,driver_id,started_at,eta_updated_at,last_error,request_count FROM mealcart_route_execution WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 100')).rows;
 res.json({ok:true,data:{enabled:messaging.NOTIFICATIONS_ENABLED,timeZone:messaging.DELIVERY_TIMEZONE,events:scheduledEvents,messages,health,executions,schedules:await listReminderSchedules()}});
}));
adminMessagingRouter.get('/delivery-messaging/jobs',asyncHandler(async(req,res)=>{
 const date=String(req.query.date??'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new ApiError(400,'BAD_DATE','Use YYYY-MM-DD');
 const planned=await plannedJobs(date);
 const schedules=await listReminderSchedules();const result=[];
 for(const source of planned.jobs){
  const checks=[];
  for(const event of scheduledEvents){
   if(event===REMINDER_EVENT){
    for(const schedule of schedules){
     const c=await notificationContext(source.id,event,schedule.templateId,schedule.channel,source.kind);
     if(c.job?.group_id===schedule.groupId)checks.push({event:schedule.name,problem:c.problem,group:schedule.groupId,channel:schedule.channel});
    }
   }else for(const channel of notificationChannels){
    const c=await notificationContext(source.id,event,undefined,channel,source.kind);
    checks.push({event,problem:c.problem,group:c.job?.group_id??null,channel});
   }
  }
  result.push({id:source.id,do_number:source.doNumber,sourceKind:source.kind,planId:source.planId,checks});
 }
 res.json({ok:true,data:{jobs:result,issues:planned.issues}});
}));

adminMessagingRouter.post('/delivery-messaging/:id/retry',asyncHandler(async(req,res)=>{if(!z.string().uuid().safeParse(req.params.id).success)throw new ApiError(400,'BAD_ID','Invalid message ID');res.json({ok:true,data:await retryNotification(req.params.id)});}));

// Reminder timing is saved only through message-template endpoints.

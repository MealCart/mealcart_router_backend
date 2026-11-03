import nodemailer from 'nodemailer';
import {messaging as cfg} from '../config/delivery-messaging.js';
export class ProviderFailure extends Error {constructor(public disposition:'blocked'|'failed'|'unknown',message:string){super(message);}}
export async function sendNotification(message:{id:string;channel:string;recipient:string;body:string;subject:string}){
 if(message.channel==='SMS'){
  if(!cfg.TWILIO_ACCOUNT_SID||!cfg.TWILIO_AUTH_TOKEN||!cfg.TWILIO_FROM_NUMBER)throw new ProviderFailure('blocked','Twilio environment variables are missing');
  let response:Response;
  try{response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.TWILIO_ACCOUNT_SID)}/Messages.json`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:message.recipient,From:cfg.TWILIO_FROM_NUMBER,Body:message.body}),signal:AbortSignal.timeout(20000)});}catch{throw new ProviderFailure('unknown','Twilio response was interrupted; check the Twilio console before any manual resend');}
  const data:any=await response.json().catch(()=>null);
  if(!response.ok)throw new ProviderFailure(response.status>=500?'unknown':'failed',`Twilio rejected request (HTTP ${response.status}, code ${Number(data?.code)||'unavailable'})`);
  if(!data?.sid)throw new ProviderFailure('unknown','Twilio response did not include a message identifier');
  return String(data.sid);
 }
 if(!cfg.SMTP_USER||!cfg.SMTP_PASSWORD)throw new ProviderFailure('blocked','SMTP environment variables are missing');
 const transport=nodemailer.createTransport({host:cfg.SMTP_HOST,port:cfg.SMTP_PORT,secure:cfg.SMTP_PORT===465,requireTLS:true,auth:{user:cfg.SMTP_USER,pass:cfg.SMTP_PASSWORD},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000,logger:false,debug:false});
 try{const result=await transport.sendMail({from:{name:cfg.EMAIL_FROM_NAME,address:cfg.EMAIL_FROM},to:message.recipient,subject:message.subject.replace(/[\r\n]/g,' '),text:message.body,messageId:`<mealcart-${message.id}@${cfg.EMAIL_FROM.split('@')[1]||'mealcart.com.au'}>`});if(!result.accepted?.length)throw new ProviderFailure('failed','SMTP server rejected recipient');return String(result.messageId);}catch(error){if(error instanceof ProviderFailure)throw error;const e=error as {code?:string;responseCode?:number};throw new ProviderFailure(e.responseCode&&e.responseCode>=500?'failed':e.code==='EAUTH'?'blocked':'unknown',`SMTP ${e.code??'send interrupted'}${e.responseCode?' ('+e.responseCode+')':''}; uncertain sends are never retried automatically`);}finally{transport.close();}
}

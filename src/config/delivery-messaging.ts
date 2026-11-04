import 'dotenv/config';
import {z} from 'zod';
export const messaging=z.object({
 NOTIFICATIONS_ENABLED:z.enum(['true','false']).default('false').transform(v=>v==='true'),
 DELIVERY_TIMEZONE:z.string().default('Australia/Melbourne').refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Invalid IANA timezone'),
 NOTIFICATION_GRACE_MINUTES:z.coerce.number().int().min(1).max(180).default(60),
 ETA_REFRESH_SECONDS:z.coerce.number().int().min(300).max(3600).default(300),
 ETA_MAX_REQUESTS_PER_ROUTE_DAY:z.coerce.number().int().min(1).max(500).default(120),
 TWILIO_ACCOUNT_SID:z.string().default(''),TWILIO_AUTH_TOKEN:z.string().default(''),TWILIO_FROM_NUMBER:z.string().default(''),
 SMTP_HOST:z.string().default('smtp.hostinger.com'),SMTP_PORT:z.coerce.number().int().default(465),SMTP_USER:z.string().default(''),SMTP_PASSWORD:z.string().default(''),
 EMAIL_FROM:z.string().default('delivery@mealcart.com.au'),EMAIL_FROM_NAME:z.string().default('Mealcart'),
}).parse(process.env);

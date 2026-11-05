export const scheduledEvents=['Scheduled Delivery Reminder','Delivery ETA — One Hour','Delivery Failed','Delivery Completed','Daily Schedule Update'] as const;
export function localClock(now:Date,timeZone:string){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
 return{date:`${p.year}-${p.month}-${p.day}`,seconds:Number(p.hour)*3600+Number(p.minute)*60+Number(p.second)};
}
export function nextDate(date:string){return new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);}

export function renderMessage(text:string,vars:Record<string,string>){return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g,(_whole,key)=>{if(!(key in vars))throw new Error(`Unknown template placeholder: ${key}`);return vars[key];});}
export function phoneE164(value:string){let v=value.trim().replace(/[\s()-]/g,'');if(/^0[2-478]\d{8}$/.test(v))v='+61'+v.slice(1);if(!/^\+[1-9]\d{7,14}$/.test(v))throw new Error('Customer phone must be E.164 (+country code) or a valid Australian local number');return v;}

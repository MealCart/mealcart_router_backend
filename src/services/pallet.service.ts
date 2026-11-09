import {createHash,randomUUID} from 'node:crypto';
import {pool} from '../db/pool.js';
import {ApiError} from '../types/api.types.js';
export const palletTypes=['CHEP','LOSCAM','PLAIN'] as const;
export interface PalletInput {requestId:string;customerId:number;palletType:string;kind:'collection'|'issue';quantity:number;occurredAt:string;notes:string}
export interface PalletActor {id:string;name:string;role:'driver'|'admin'|'staff'}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const emailValid=(value:string)=>value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const publicMovement=(r:any)=>({id:r.id,sequence:String(r.sequence),customerId:r.customer_id,clientName:r.client_name,driverId:r.driver_id,driverName:r.driver_name,palletType:r.pallet_type,kind:r.entry_kind,quantity:r.quantity,delta:r.delta,reversesId:r.reverses_id,occurredAt:r.occurred_at,recordedAt:r.recorded_at,actorName:r.actor_name,notes:r.notes,balanceAfter:Number(r.balance_after),reversedBy:r.reversed_by??null,emails:(r.emails??[]).map((e:any)=>({id:e.id,role:e.recipient_role,status:e.status,detail:e.detail,recipient:e.recipient,providerId:e.provider_id,attempts:e.attempts}))});
export async function palletClients(includeHistorical=false,db:Pick<typeof pool,'query'>=pool){return(await db.query(`
 SELECT id,COALESCE(NULLIF(company_name,''),NULLIF(trim(concat_ws(' ',first_name,last_name)),''),email,'Client '||id) AS name
 FROM users u WHERE lower(role::text)='customer' AND (lower(status::text)='active' OR ($1::boolean AND EXISTS(SELECT 1 FROM mealcart_pallet_movements m WHERE m.customer_id=u.id)))
 UNION ALL SELECT m.customer_id AS id,max(m.client_name)||' (archived account)' AS name FROM mealcart_pallet_movements m
 WHERE $1::boolean AND NOT EXISTS(SELECT 1 FROM users u WHERE u.id=m.customer_id AND lower(u.role::text)='customer') GROUP BY m.customer_id ORDER BY name,id`,[includeHistorical])).rows;}

export async function palletBalances(customerId?:number,db:Pick<typeof pool,'query'>=pool){return(await db.query(`SELECT m.customer_id AS "customerId",COALESCE(NULLIF(u.company_name,''),NULLIF(trim(concat_ws(' ',u.first_name,u.last_name)),''),max(m.client_name)) AS "clientName",m.pallet_type AS "palletType",
 SUM(CASE WHEN m.entry_kind='collection' THEN m.quantity WHEN m.entry_kind='reversal' AND m.delta<0 THEN -m.quantity ELSE 0 END)::int AS collected,
 SUM(CASE WHEN m.entry_kind='issue' THEN m.quantity WHEN m.entry_kind='reversal' AND m.delta>0 THEN -m.quantity ELSE 0 END)::int AS issued,
 SUM(m.delta)::bigint AS balance FROM mealcart_pallet_movements m LEFT JOIN users u ON u.id=m.customer_id WHERE ($1::int IS NULL OR m.customer_id=$1) GROUP BY m.customer_id,u.company_name,u.first_name,u.last_name,m.pallet_type ORDER BY "clientName",m.pallet_type`,[customerId??null])).rows.map(r=>({...r,balance:Number(r.balance)}));}
async function existing(c:any,id:string,digest:string){const row=(await c.query('SELECT * FROM mealcart_pallet_movements WHERE id=$1',[id])).rows[0];if(row&&row.input_hash!==digest)throw new ApiError(409,'PALLET_REQUEST_CONFLICT','This receipt ID belongs to a different request. Keep it for office review.');return row;}
async function enqueue(c:any,r:any,clientEmail:string,driverEmail:string){
 const at=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',dateStyle:'medium',timeStyle:'short'}).format(new Date(r.occurred_at));
 const action=r.entry_kind==='collection'?'collected from client':r.entry_kind==='issue'?'issued to client':`office reversal of ${r.delta>0?'an issue':'a collection'}`;
 const balance=Number(r.balance_after),explanation=balance>0?`Mealcart owes the client ${balance} ${r.pallet_type} pallets.`:balance<0?`The client owes Mealcart ${-balance} ${r.pallet_type} pallets.`:`No ${r.pallet_type} pallets are owed on either side.`;
 const subject=`Mealcart pallet ${r.entry_kind} receipt | ${r.pallet_type} | ${r.client_name}`;
 const body=`Mealcart pallet receipt\n\nClient: ${r.client_name}\nDriver: ${r.driver_name}\nAction: ${action}\nPallet type: ${r.pallet_type}\nQuantity: ${r.quantity}\nHandover time: ${at} (Australia/Melbourne)\nReceipt: ${r.id}\n${r.reverses_id?'Reversal of receipt: '+r.reverses_id+'\n':''}${r.notes?'Note: '+r.notes+'\n':''}\nBalance after this entry was recorded: ${balance}\n${explanation}\n\nIf any information is incorrect, contact the Mealcart administrator. Drivers cannot alter or delete pallet receipts. The office can record a correction with a reason.`;
 for(const [role,raw] of [['client',clientEmail],['driver',driverEmail]]){const recipient=String(raw??'').trim();const valid=emailValid(recipient);await c.query(`INSERT INTO mealcart_pallet_emails(id,movement_id,recipient_role,recipient,subject,body,status,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),r.id,role,recipient,subject,body,valid?'queued':'blocked',valid?'':`${role} email is missing or invalid. Update the account, then retry this email.`]);}
}
export async function recordPallet(input:PalletInput,driverId:string){
 const digest=hash([driverId,input.requestId,input.customerId,input.palletType,input.kind,input.quantity,input.occurredAt,input.notes]);const c=await pool.connect();
 try{await c.query('BEGIN');let prior=await existing(c,input.requestId,digest);if(prior){await c.query('COMMIT');return publicMovement(prior);}
  const driver=(await c.query(`SELECT public_id,name,email FROM drivers WHERE public_id=$1 AND lower(status::text)='active' FOR SHARE`,[driverId])).rows[0];
  const client=(await c.query(`SELECT id,email,COALESCE(NULLIF(company_name,''),NULLIF(trim(concat_ws(' ',first_name,last_name)),''),email,'Client '||id) AS name FROM users WHERE id=$1 AND lower(role::text)='customer' AND lower(status::text)='active' FOR SHARE`,[input.customerId])).rows[0];
  if(!driver||!client)throw new ApiError(409,'PALLET_ACCOUNT_UNAVAILABLE','Choose an active client and sign in with an active driver account. Your local receipt is retained.');
  if(Date.parse(input.occurredAt)>Date.now()+300000||Date.parse(input.occurredAt)<Date.now()-90*86400000)throw new ApiError(409,'PALLET_CLOCK','Handover time is invalid or older than 90 days. Contact the office; your saved receipt is retained.');
  await c.query('SELECT pg_advisory_xact_lock(740322,$1)',[input.customerId]);prior=await existing(c,input.requestId,digest);if(prior){await c.query('COMMIT');return publicMovement(prior);}
  const balance=Number((await c.query(`SELECT COALESCE(SUM(delta),0) AS balance FROM mealcart_pallet_movements WHERE customer_id=$1 AND pallet_type=$2`,[input.customerId,input.palletType])).rows[0].balance);
  const delta=input.kind==='collection'?input.quantity:-input.quantity;
  const row=(await c.query(`INSERT INTO mealcart_pallet_movements(id,customer_id,client_name,driver_id,driver_name,pallet_type,entry_kind,quantity,delta,occurred_at,actor_type,actor_id,actor_name,notes,input_hash,balance_after) VALUES($1,$2,$3,$4::text,$5,$6,$7,$8,$9,$10,'driver',$4::text,$5,$11,$12,$13) RETURNING *`,[input.requestId,input.customerId,client.name,driverId,driver.name,input.palletType,input.kind,input.quantity,delta,input.occurredAt,input.notes,digest,balance+delta])).rows[0];
  await enqueue(c,row,client.email,driver.email);await c.query('COMMIT');return publicMovement(row);
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export async function reversePallet(id:string,requestId:string,note:string,actor:PalletActor){
 if(actor.role!=="admin")throw new ApiError(403,"PALLET_ADMIN_REQUIRED","Only an administrator can reverse movements.");
 const digest=hash([id,requestId,note,actor.id,actor.role]);const c=await pool.connect();
 try{await c.query('BEGIN');let prior=await existing(c,requestId,digest);if(prior){await c.query('COMMIT');return publicMovement(prior);}
  const initial=(await c.query('SELECT * FROM mealcart_pallet_movements WHERE id=$1',[id])).rows[0];
  if(!initial||initial.entry_kind==='reversal')throw new ApiError(409,'PALLET_NOT_REVERSIBLE','Only an original collection or issue can be reversed.');
  await c.query('SELECT pg_advisory_xact_lock(740322,$1)',[initial.customer_id]);prior=await existing(c,requestId,digest);if(prior){await c.query('COMMIT');return publicMovement(prior);}
  if((await c.query('SELECT id FROM mealcart_pallet_movements WHERE reverses_id=$1',[id])).rows.length)throw new ApiError(409,'PALLET_ALREADY_REVERSED','This movement has already been reversed.');
  const balance=Number((await c.query('SELECT COALESCE(SUM(delta),0) AS balance FROM mealcart_pallet_movements WHERE customer_id=$1 AND pallet_type=$2',[initial.customer_id,initial.pallet_type])).rows[0].balance);
  const row=(await c.query(`INSERT INTO mealcart_pallet_movements(id,customer_id,client_name,driver_id,driver_name,pallet_type,entry_kind,quantity,delta,reverses_id,occurred_at,actor_type,actor_id,actor_name,notes,input_hash,balance_after) VALUES($1,$2,$3,$4,$5,$6,'reversal',$7,$8,$9,clock_timestamp(),$10,$11,$12,$13,$14,$15) RETURNING *`,[requestId,initial.customer_id,initial.client_name,initial.driver_id,initial.driver_name,initial.pallet_type,initial.quantity,-initial.delta,id,actor.role,actor.id,actor.name,note,digest,balance-initial.delta])).rows[0];
  const client=(await c.query('SELECT email FROM users WHERE id=$1',[initial.customer_id])).rows[0],driver=(await c.query('SELECT email FROM drivers WHERE public_id=$1',[initial.driver_id])).rows[0];
  await enqueue(c,row,client?.email??'',driver?.email??'');await c.query('COMMIT');return publicMovement(row);
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export interface PalletFilters {customerId?:number;from?:string;to?:string;type?:string;before?:number;driverId?:string;limit?:number}
export async function palletMovements(f:PalletFilters={},db:Pick<typeof pool,'query'>=pool){
 const rows=(await db.query(`SELECT m.*,r.id AS reversed_by,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'recipient_role',e.recipient_role,'recipient',e.recipient,'status',e.status,'detail',e.detail,'provider_id',e.provider_id,'attempts',e.attempts) ORDER BY e.recipient_role) FROM mealcart_pallet_emails e WHERE e.movement_id=m.id),'[]'::jsonb) AS emails
 FROM mealcart_pallet_movements m LEFT JOIN mealcart_pallet_movements r ON r.reverses_id=m.id
 WHERE ($1::int IS NULL OR m.customer_id=$1) AND ($2::date IS NULL OR m.occurred_at>=($2::date::timestamp AT TIME ZONE 'Australia/Melbourne')) AND ($3::date IS NULL OR m.occurred_at<(($3::date+1)::timestamp AT TIME ZONE 'Australia/Melbourne')) AND ($4::text IS NULL OR m.pallet_type=$4) AND ($5::bigint IS NULL OR m.sequence<$5) AND ($6::text IS NULL OR m.driver_id=$6)
 ORDER BY m.sequence DESC LIMIT $7`,[f.customerId??null,f.from??null,f.to??null,f.type??null,f.before??null,f.driverId??null,f.limit??200])).rows;
 return rows.map(publicMovement);
}
export async function palletSnapshot(driverId?:string,filters:PalletFilters={}){
 const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const snapshot={driverId:driverId??null,clients:await palletClients(!driverId,c),balances:await palletBalances(undefined,c),movements:(await palletMovements({...filters,driverId},c)).map(m=>driverId?{...m,emails:m.emails.map((e:any)=>({role:e.role,status:e.status}))}:m),at:new Date().toISOString()};
 await c.query('COMMIT');return snapshot;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}

export async function palletStatement(customerId:number,from?:string,to?:string){
 const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const client=(await c.query(`SELECT id,COALESCE(NULLIF(company_name,''),NULLIF(trim(concat_ws(' ',first_name,last_name)),''),email,'Client '||id) AS name FROM users WHERE id=$1 AND lower(role::text)='customer'`,[customerId])).rows[0]??(await c.query('SELECT customer_id AS id,client_name AS name FROM mealcart_pallet_movements WHERE customer_id=$1 ORDER BY sequence DESC LIMIT 1',[customerId])).rows[0];if(!client)throw new ApiError(404,'CLIENT_NOT_FOUND','Client not found.');
 const openingRows=(await c.query(`SELECT pallet_type,SUM(delta) AS balance FROM mealcart_pallet_movements WHERE customer_id=$1 AND $2::date IS NOT NULL AND occurred_at<($2::date::timestamp AT TIME ZONE 'Australia/Melbourne') GROUP BY pallet_type`,[customerId,from??null])).rows;
 const opening=Object.fromEntries(palletTypes.map(t=>[t,Number(openingRows.find(r=>r.pallet_type===t)?.balance??0)]));
 const rows=(await c.query(`SELECT * FROM mealcart_pallet_movements WHERE customer_id=$1 AND ($2::date IS NULL OR occurred_at>=($2::date::timestamp AT TIME ZONE 'Australia/Melbourne')) AND ($3::date IS NULL OR occurred_at<(($3::date+1)::timestamp AT TIME ZONE 'Australia/Melbourne')) ORDER BY occurred_at,sequence LIMIT 10001`,[customerId,from??null,to??null])).rows;
 if(rows.length>10000)throw new ApiError(422,'REPORT_TOO_LARGE','Select a shorter report period (maximum 10,000 entries).');
 const closing={...opening};const movements=rows.map(r=>{closing[r.pallet_type]+=r.delta;return{...publicMovement(r),runningBalance:closing[r.pallet_type]};});await c.query('COMMIT');return{client,from:from??null,to:to??null,opening,closing,movements,generatedAt:new Date().toISOString()};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}

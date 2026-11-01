import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { ApiError } from "../types/api.types.js";
import type { RegisterKeyInput, IssueKeyInput, KeyMovementInput } from "../validators/key.validator.js";

const selection = `SELECT k.id,k.name,k.customer_id::text AS "customerId",k.client_name AS "clientName",k.notes,k.version,
 k.created_at AS "createdAt",k.updated_at AS "updatedAt",
 CASE WHEN i.status='pending' THEN 'Pending acceptance' WHEN i.status='accepted' THEN 'With driver' ELSE 'In office' END AS status,
 CASE WHEN i.id IS NULL THEN NULL ELSE jsonb_build_object('id',i.id,'driverId',i.driver_id,'driverName',i.driver_name,
 'issuedAt',i.issued_at,'acceptedAt',i.accepted_at) END AS "activeIssue",
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'issueId',e.issue_id,'action',e.action,'at',e.at,
 'driverId',e.driver_id,'driverName',e.driver_name,'recordedBy',e.actor_name,'actorType',e.actor_type,'notes',e.notes) ORDER BY e.id)
 FROM mealcart_key_events e WHERE e.key_id=k.id),'[]'::jsonb) AS history
 FROM mealcart_keys k LEFT JOIN mealcart_key_issues i ON i.key_id=k.id AND i.status IN ('pending','accepted')`;

async function transaction<T>(run: (c: PoolClient) => Promise<T>): Promise<T> {
 const c = await pool.connect();
 try { await c.query("BEGIN"); const out = await run(c); await c.query("COMMIT"); return out; }
 catch (err) {
  await c.query("ROLLBACK");
  const code = (err as {code?: string}).code;
  if (code==='23505' || code==='23503') throw new ApiError(409,"KEY_CONFLICT","The key, driver or customer changed. Refresh and try again.");
  throw err;
 } finally { c.release(); }
}
async function staff(c: PoolClient, userId: number) {
 const u = (await c.query(`SELECT id,role,status,COALESCE(NULLIF(trim(concat_ws(' ',first_name,last_name)),''),email) AS name FROM users WHERE id=$1 FOR SHARE`,[userId])).rows[0];
 if (!u || !['admin','staff'].includes(u.role) || u.status!=='active') throw new ApiError(403,"FORBIDDEN","An active admin or staff account is required.");
 return u;
}
async function lockedKey(c: PoolClient,id: string,version?: number) {
 const row = (await c.query("SELECT id,version FROM mealcart_keys WHERE id=$1 FOR UPDATE",[id])).rows[0];
 if (!row) throw new ApiError(404,"KEY_NOT_FOUND","Key not found.");
 if (version!==undefined && row.version!==version) throw new ApiError(409,"KEY_CHANGED","This key changed. Refresh and reopen this action.");
 return row;
}
async function get(c: PoolClient,id: string) { return (await c.query(selection+" WHERE k.id=$1",[id])).rows[0]; }
async function bump(c: PoolClient,id: string) { await c.query("UPDATE mealcart_keys SET version=version+1,updated_at=clock_timestamp() WHERE id=$1",[id]); }
async function event(c: PoolClient,keyId: string,issue: {id:string;driver_id:string;driver_name:string}|null,action: string,actor: {id:number|string;name:string;type:'staff'|'driver'},notes: string) {
 await c.query(`INSERT INTO mealcart_key_events(key_id,issue_id,action,actor_type,actor_user_id,actor_driver_id,actor_name,driver_id,driver_name,notes)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[keyId,issue?.id??null,action,actor.type,actor.type==='staff'?actor.id:null,actor.type==='driver'?actor.id:null,actor.name,issue?.driver_id??null,issue?.driver_name??null,notes]);
}
export async function listKeys() { return (await pool.query(selection+" ORDER BY k.id DESC")).rows; }
export async function getKey(id: string) {
 const row=(await pool.query(selection+" WHERE k.id=$1",[id])).rows[0];
 if (!row) throw new ApiError(404,"KEY_NOT_FOUND","Key not found.");
 return row;
}
export async function registerKey(input: RegisterKeyInput,userId: number) {
 return transaction(async c=>{
  const actor=await staff(c,userId);
  const customer=(await c.query(`SELECT role,COALESCE(NULLIF(trim(company_name),''),NULLIF(trim(concat_ws(' ',first_name,last_name)),''),email) AS name FROM users WHERE id=$1 FOR SHARE`,[input.customerId])).rows[0];
  if (!customer || customer.role!=='customer') throw new ApiError(400,"INVALID_CUSTOMER","Select a customer from the database.");
  const key=(await c.query("INSERT INTO mealcart_keys(customer_id,client_name,name,notes) VALUES($1,$2,$3,$4) RETURNING id",[input.customerId,customer.name,input.name,input.notes])).rows[0];
  await event(c,key.id,null,'Registered',{id:userId,name:actor.name,type:'staff'},'Key registered in office custody');
  return get(c,key.id);
 });
}
export async function issueKey(id: string,input: IssueKeyInput,userId: number) {
 return transaction(async c=>{
  await lockedKey(c,id,input.version);
  const actor=await staff(c,userId);
  if ((await c.query("SELECT id FROM mealcart_key_issues WHERE key_id=$1 AND status IN ('pending','accepted')",[id])).rows.length) throw new ApiError(409,"KEY_NOT_AVAILABLE","Receive the key or cancel the pending issue before issuing it again.");
  const driver=(await c.query("SELECT public_id,name,status FROM drivers WHERE public_id=$1 FOR SHARE",[input.driverId])).rows[0];
  if (!driver || driver.status!=='Active') throw new ApiError(400,"INVALID_DRIVER","Select an active driver.");
  const issue=(await c.query(`INSERT INTO mealcart_key_issues(id,key_id,driver_id,driver_name,status,issued_by) VALUES($1,$2,$3,$4,'pending',$5) RETURNING *`,[randomUUID(),id,driver.public_id,driver.name,userId])).rows[0];
  await event(c,id,issue,'Issued',{id:userId,name:actor.name,type:'staff'},input.notes);
  await bump(c,id);return get(c,id);
 });
}
export async function receiveOrCancelKey(id: string,input: KeyMovementInput,userId: number,action: 'Received'|'Cancelled') {
 return transaction(async c=>{
  await lockedKey(c,id,input.version);
  const actor=await staff(c,userId);
  const issue=(await c.query("SELECT * FROM mealcart_key_issues WHERE id=$1 AND key_id=$2 FOR UPDATE",[input.issueId,id])).rows[0];
  const required=action==='Received'?'accepted':'pending';
  if (!issue || issue.status!==required) throw new ApiError(409,"KEY_STATE_CHANGED",action==='Received'?'Only an accepted key can be received. Refresh the register.':'Only a pending issue can be cancelled. Refresh the register.');
  if (action==='Received') await c.query("UPDATE mealcart_key_issues SET status='received',received_at=clock_timestamp(),received_by=$2 WHERE id=$1",[issue.id,userId]);
  else await c.query("UPDATE mealcart_key_issues SET status='cancelled',cancelled_at=clock_timestamp(),cancelled_by=$2 WHERE id=$1",[issue.id,userId]);
  await event(c,id,issue,action,{id:userId,name:actor.name,type:'staff'},input.notes);
  await bump(c,id);return get(c,id);
 });
}
/** FUTURE DRIVER APP ONLY. Never expose this behind the admin session or trust a body driverId.
 * A future route must supply authenticatedDriverId from verified driver authentication.
 * Scan yields keyId; fetch pending issueId for that authenticated driver before accepting.
 */
export async function acceptKeyForDriver(keyId: string,issueId: string,authenticatedDriverId: string) {
 return transaction(async c=>{
  await lockedKey(c,keyId);
  const issue=(await c.query("SELECT * FROM mealcart_key_issues WHERE id=$1 AND key_id=$2 FOR UPDATE",[issueId,keyId])).rows[0];
  if (!issue || issue.driver_id!==authenticatedDriverId) throw new ApiError(403,"KEY_NOT_ASSIGNED","This key issue is not assigned to this driver.");
  const driver=(await c.query("SELECT public_id,name,status FROM drivers WHERE public_id=$1 FOR SHARE",[authenticatedDriverId])).rows[0];
  if (!driver || driver.status!=='Active') throw new ApiError(403,"DRIVER_INACTIVE","An active driver account is required.");
  if (issue.status==='accepted') return get(c,keyId); // Repeat scan is idempotent for this issue only.
  if (issue.status!=='pending') throw new ApiError(409,"ISSUE_CLOSED","This issue is closed. Scan and select the current pending issue.");
  await c.query("UPDATE mealcart_key_issues SET status='accepted',accepted_at=clock_timestamp() WHERE id=$1",[issue.id]);
  await event(c,keyId,issue,'Accepted',{id:driver.public_id,name:driver.name,type:'driver'},'Driver accepted by barcode scan');
  await bump(c,keyId);return get(c,keyId);
 });
}

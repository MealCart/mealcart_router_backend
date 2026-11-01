import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import { ApiError } from "../types/api.types.js";
import type { GroupInput, TemplateInput } from "../validators/group.validator.js";

const groupSelect = `SELECT g.id, g.name, g.description, g.preferred_contact AS contact,
 g.status, g.record_temperature AS "recordTemperature", g.version,
 COALESCE((SELECT jsonb_agg(m.user_id::text ORDER BY m.user_id)
 FROM mealcart_group_members m JOIN users u ON u.id=m.user_id
 WHERE m.group_id=g.id AND u.role='customer'), '[]'::jsonb) AS "memberIds",
 COALESCE((SELECT jsonb_agg(t.template_id ORDER BY t.template_id)
 FROM mealcart_group_templates t WHERE t.group_id=g.id), '[]'::jsonb) AS "templateIds"
 FROM mealcart_customer_groups g`;
const templateSelect = `SELECT id,name,description,channel,event,subject,body,status,
 to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "updatedAt" FROM mealcart_message_templates`;

export async function listGroups() { return (await pool.query(groupSelect + " ORDER BY lower(g.name),g.id")).rows; }
export async function getGroup(id: string) {
 const row = (await pool.query(groupSelect + " WHERE g.id=$1", [id])).rows[0];
 if (!row) throw new ApiError(404,"GROUP_NOT_FOUND","Group not found.");
 return row;
}
export async function listGroupCustomers() {
 // Never SELECT *: no password hashes or other login/security columns are returned.
 return (await pool.query(`SELECT u.id::text AS id,
 COALESCE(NULLIF(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email,'Customer') AS name,
 COALESCE(u.email,'') AS email, COALESCE(u.phone,'') AS phone,
 COALESCE(u.company_name,'') AS company, COALESCE(u.address,'') AS address,
 u.status, COALESCE(m.group_id,u.group_id) AS "groupId",
 COALESCE(g.name,u.group_name) AS "groupName", g.preferred_contact AS contact
 FROM users u LEFT JOIN mealcart_group_members m ON m.user_id=u.id
 LEFT JOIN mealcart_customer_groups g ON g.id=m.group_id
 WHERE u.role='customer' ORDER BY lower(COALESCE(u.first_name,'')),u.id`)).rows;
}
async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
 const client = await pool.connect();
 try {
  await client.query("BEGIN");
  // Serialize group/template writes, including member transfers between groups.
  await client.query("SELECT pg_advisory_xact_lock(740321, 2)");
  const result = await run(client); await client.query("COMMIT"); return result;
 } catch (err) {
  await client.query("ROLLBACK");
  const pg = err as { code?: string; constraint?: string };
  if (pg.code === "23505" && pg.constraint === "mealcart_customer_groups_name_idx") throw new ApiError(409,"GROUP_NAME_TAKEN","A group with this name already exists.");
  if (pg.code === "23503") throw new ApiError(409,"RELATED_RECORD_CHANGED","A related record changed. Refresh and try again.");
  throw err;
 } finally { client.release(); }
}
export async function saveGroup(input: GroupInput, id?: string, version?: number) {
 return transaction(async client => {
  const groupId = id ?? `GRP-${randomUUID()}`;
  if (id) {
   const old = (await client.query("SELECT version FROM mealcart_customer_groups WHERE id=$1 FOR UPDATE",[id])).rows[0];
   if (!old) throw new ApiError(404,"GROUP_NOT_FOUND","Group not found.");
   if (old.version !== version) throw new ApiError(409,"GROUP_CHANGED","This group changed. Close the editor, refresh, and reopen it before saving.");
  }
  // Lock and revalidate all selected users so a forged admin/staff ID cannot be saved.
  const members = await client.query("SELECT id,role FROM users WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE",[input.memberIds]);
  if (members.rows.length !== input.memberIds.length || members.rows.some(u => u.role !== "customer")) throw new ApiError(400,"INVALID_MEMBERS","Every selected member must exist and have role customer. Refresh the customer list.");
  const templates = await client.query("SELECT id FROM mealcart_message_templates WHERE id=ANY($1::varchar[]) FOR SHARE",[input.templateIds]);
  if (templates.rows.length !== input.templateIds.length) throw new ApiError(400,"INVALID_TEMPLATES","A selected template no longer exists. Refresh and try again.");
  const values = [input.name,input.description,input.contact,input.status,input.recordTemperature,groupId];
  if (id) await client.query("UPDATE mealcart_customer_groups SET name=$1,description=$2,preferred_contact=$3,status=$4,record_temperature=$5,version=version+1,updated_at=NOW() WHERE id=$6", values);
  else await client.query("INSERT INTO mealcart_customer_groups (name,description,preferred_contact,status,record_temperature,id) VALUES ($1,$2,$3,$4,$5,$6)",values);
  // Mark source groups changed so an editor opened before a transfer cannot undo it silently.
  await client.query(`UPDATE mealcart_customer_groups SET version=version+1,updated_at=NOW()
   WHERE id IN (SELECT group_id FROM mealcart_group_members WHERE user_id=ANY($1::int[]) AND group_id<>$2)`,[input.memberIds,groupId]);
  await client.query(`UPDATE users SET group_id=NULL,group_name=NULL,group_linked_at=NULL,updated_at=NOW()
   WHERE group_id=$1 AND NOT(id=ANY($2::int[]))`,[groupId,input.memberIds]);
  await client.query("DELETE FROM mealcart_group_members WHERE group_id=$1 AND NOT(user_id=ANY($2::int[]))",[groupId,input.memberIds]);
  await client.query(`INSERT INTO mealcart_group_members (group_id,user_id)
   SELECT $1,unnest($2::int[]) ON CONFLICT (user_id) DO UPDATE SET group_id=EXCLUDED.group_id,
   linked_at=CASE WHEN mealcart_group_members.group_id<>EXCLUDED.group_id THEN NOW() ELSE mealcart_group_members.linked_at END`,[groupId,input.memberIds]);
  await client.query(`UPDATE users u SET group_id=$1::varchar,group_name=$2::varchar,
   group_linked_at=CASE WHEN u.group_id IS DISTINCT FROM $1::varchar THEN NOW() ELSE COALESCE(u.group_linked_at,NOW()) END,
   updated_at=NOW() WHERE u.id=ANY($3::int[]) AND u.role='customer'`,[groupId,input.name,input.memberIds]);
  await client.query("DELETE FROM mealcart_group_templates WHERE group_id=$1",[groupId]);
  await client.query("INSERT INTO mealcart_group_templates (group_id,template_id) SELECT $1,unnest($2::varchar[])",[groupId,input.templateIds]);
  return (await client.query(groupSelect + " WHERE g.id=$1",[groupId])).rows[0];
 });
}
export async function deleteGroup(id: string, version: number) {
 return transaction(async client => {
  const old = (await client.query("SELECT version FROM mealcart_customer_groups WHERE id=$1 FOR UPDATE",[id])).rows[0];
  if (!old) throw new ApiError(404,"GROUP_NOT_FOUND","Group not found.");
  if (old.version !== version) throw new ApiError(409,"GROUP_CHANGED","This group changed. Refresh before deleting.");
  await client.query("UPDATE users SET group_id=NULL,group_name=NULL,group_linked_at=NULL,updated_at=NOW() WHERE group_id=$1",[id]);
  await client.query("DELETE FROM mealcart_customer_groups WHERE id=$1",[id]);
 });
}
export async function listTemplates() { return (await pool.query(templateSelect + " ORDER BY name,id")).rows; }
export async function saveTemplate(input: TemplateInput, id?: string) {
 return transaction(async client => {
  const templateId = id ?? `TPL-${randomUUID()}`;
  if (id && !(await client.query("SELECT id FROM mealcart_message_templates WHERE id=$1",[id])).rows.length) throw new ApiError(404,"TEMPLATE_NOT_FOUND","Template not found.");
  const duplicate = await client.query(`SELECT id FROM mealcart_message_templates WHERE lower(trim(name))=lower(trim($1))
   AND event=$2 AND (channel=$3 OR channel='Both' OR $3='Both') AND id<>$4`,[input.name,input.event,input.channel,templateId]);
  if (duplicate.rows.length) throw new ApiError(409,"TEMPLATE_EXISTS","A template with this name already exists for this event and channel.");
  let affectedGroupIds: string[] = [];
  if (input.groupIds !== undefined) {
   const current = await client.query("SELECT group_id FROM mealcart_group_templates WHERE template_id=$1", [templateId]);
   affectedGroupIds = [...new Set([...input.groupIds, ...current.rows.map(row => row.group_id as string)])].sort();
   const selectedGroups = await client.query("SELECT id,version FROM mealcart_customer_groups WHERE id=ANY($1::varchar[]) ORDER BY id FOR UPDATE", [affectedGroupIds]);
   if (selectedGroups.rows.length !== affectedGroupIds.length) throw new ApiError(400,"INVALID_GROUPS","A selected group no longer exists. Refresh and try again.");
   if (selectedGroups.rows.some(group => input.groupVersions?.[group.id] !== group.version)) throw new ApiError(409,"GROUP_CHANGED","Group assignments changed. Close this editor, refresh, and reopen the template before saving.");
  }
  const values = [input.name,input.description,input.channel,input.event,input.channel==='SMS'?'':input.subject,input.body,input.status,templateId];
  if (id) await client.query("UPDATE mealcart_message_templates SET name=$1,description=$2,channel=$3,event=$4,subject=$5,body=$6,status=$7,updated_at=NOW() WHERE id=$8",values);
  else await client.query("INSERT INTO mealcart_message_templates (name,description,channel,event,subject,body,status,id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",values);
  if (input.groupIds !== undefined) {
   await client.query("DELETE FROM mealcart_group_templates WHERE template_id=$1", [templateId]);
   await client.query("INSERT INTO mealcart_group_templates (group_id,template_id) SELECT unnest($1::varchar[]),$2", [input.groupIds, templateId]);
   // Increment groups that gained OR lost this template, invalidating stale group editors.
   await client.query("UPDATE mealcart_customer_groups SET version=version+1,updated_at=NOW() WHERE id=ANY($1::varchar[])", [affectedGroupIds]);
  } else {
   // Existing clients can edit content/status without touching group assignments.
   await client.query("UPDATE mealcart_customer_groups SET version=version+1,updated_at=NOW() WHERE id IN (SELECT group_id FROM mealcart_group_templates WHERE template_id=$1)",[templateId]);
  }
  return (await client.query(templateSelect + " WHERE id=$1",[templateId])).rows[0];
 });
}
export async function deleteTemplate(id: string) {
 return transaction(async client => {
  if ((await client.query("SELECT group_id FROM mealcart_group_templates WHERE template_id=$1 LIMIT 1",[id])).rows.length) throw new ApiError(409,"TEMPLATE_IN_USE","Remove this template from its groups before deleting it, or deactivate it.");
  if (!(await client.query("DELETE FROM mealcart_message_templates WHERE id=$1 RETURNING id",[id])).rows.length) throw new ApiError(404,"TEMPLATE_NOT_FOUND","Template not found.");
 });
}

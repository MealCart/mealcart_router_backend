import { pool } from '../db/pool.js';
import { ApiError } from '../types/api.types.js';

/** Read source orders directly, including completed jobs excluded by planner filters. */
export async function getAssignedRouteDetails(id: string) {
 const client = await pool.connect();
 try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const plan = (await client.query(`SELECT *,plan_date::text AS plan_date FROM route_plans WHERE public_id=$1`, [id])).rows[0];
  if (!plan) throw new ApiError(404, 'ROUTE_PLAN_NOT_FOUND', 'This route no longer exists.');
  const arrivals = Array.isArray(plan.stop_arrivals) ? plan.stop_arrivals : [];
  const ids = (kind: string) => arrivals.flatMap((s: any) => {
   const match = new RegExp(`^STP-${kind}([1-9]\\d*)$`).exec(s.stopId);
   const value = match ? Number(match[1]) : 0;
   return value > 0 && value <= 2147483647 && Number.isSafeInteger(value) ? [value] : [];
  });
  const jobs = ids('J'), collections = ids('C');
  const details = new Map<string, any>();
  if (jobs.length) for (const row of (await client.query(`SELECT id,do_number AS "orderRef",customer_name AS "customerName",phone,delivery_address AS address,postcode,city,state,special_instructions AS notes,status AS "jobStatus" FROM jobs WHERE id=ANY($1::int[])`, [jobs])).rows) details.set(`STP-J${row.id}`, {...row, jobType: 'Delivery'});
  if (collections.length) for (const row of (await client.query(`SELECT id,do_number AS "orderRef",recipient_name AS "customerName",recipient_phone AS phone,collection_address AS address,postcode,city,state,special_instructions AS notes FROM collections WHERE id=ANY($1::int[])`, [collections])).rows) details.set(`STP-C${row.id}`, {...row, jobType: 'Collection'});
  // Snapshot + job + sequence matching prevents old proof leaking into a reused plan ID.
  const receipts = (await client.query(`SELECT c.*,d.name AS driver_name FROM mealcart_delivery_completions c LEFT JOIN drivers d ON d.public_id=c.driver_id WHERE c.plan_id=$1 AND c.plan_created_at=(SELECT created_at::timestamptz FROM route_plans WHERE public_id=$1)`, [id])).rows;
  const stops = arrivals.filter((s: any) => s.stopId !== '__DEPOT__').map((s: any) => {
   const source = details.get(s.stopId);
   const receipt = receipts.find((c: any) => c.stop_seq === s.seq && s.stopId === `STP-J${c.job_id}`);
   return {...s, available: !!source, customerName: source?.customerName || 'Source order unavailable', orderRef: source?.orderRef || s.stopId, address: source?.address || '', postcode: source?.postcode || '', city: source?.city || '', state: source?.state || '', phone: source?.phone || '', notes: source?.notes || '', jobType: source?.jobType || (/^STP-C/.test(s.stopId) ? 'Collection' : 'Delivery'), jobStatus: source?.jobStatus || '',
    completion: receipt ? {id: receipt.id, completedAt: receipt.completed_at, driverId: receipt.driver_id, driverName: receipt.driver_name || receipt.driver_id, photos: receipt.photos, signatureUrl: receipt.signature_url, barcodes: receipt.expected_barcodes} : null};
  }).sort((a: any, b: any) => a.seq - b.seq);
  await client.query('COMMIT');
  return {id: plan.public_id, stops};
 } catch (error) {await client.query('ROLLBACK').catch(() => {}); throw error;} finally {client.release();}
}

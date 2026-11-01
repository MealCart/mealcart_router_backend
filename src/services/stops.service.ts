import { pool } from "../db/pool.js";
import { logger } from "../utils/logger.js";
import { ApiError } from "../types/api.types.js";
import { geocodeBatch } from "./geocode.service.js";

export interface StopPublic {
  id: string;
  source: "job" | "collection";
  sourceId: number;
  orderRef: string;
  customerName: string;
  phone: string;
  address: string;
  postcode: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
  jobType: "Delivery" | "Collection";
  window: string;
  status: string;
  date: string;
  notes: string;
  geocodeFailed: boolean;
}

interface JobRow {
  id: number;
  do_number: string | null;
  customer_name: string | null;
  phone: string | null;
  delivery_address: string | null;
  postcode: string | null;
  city: string | null;
  state: string | null;
  scheduled_date: string | null;
  special_instructions: string | null;
  status: string | null;
  latitude: number | null;
  longitude: number | null;
  geocode_status: string | null;
}

interface CollectionRow {
  id: number;
  do_number: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  collection_address: string | null;
  postcode: string | null;
  city: string | null;
  state: string | null;
  scheduled_date: string | null;
  special_instructions: string | null;
  status: string | null;
  time_window: string | null;
  latitude: number | null;
  longitude: number | null;
  geocode_status: string | null;
}

/** Build a well-formed address string for geocoding. */
function buildGeocodeAddress(parts: {
  base: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
}): string {
  const { base, city, state, postcode } = parts;
  if (!base) return "";
  // If the base already contains a postcode digit sequence, trust it
  if (/\b\d{4}\b/.test(base)) {
    return /australia/i.test(base) ? base : `${base}, Australia`;
  }
  const tail = [city, state, postcode].filter(Boolean).join(" ");
  return [base, tail, "Australia"].filter(Boolean).join(", ");
}

export async function listStopsForDate(date: string): Promise<StopPublic[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "BAD_DATE", "date must be YYYY-MM-DD");
  }

  // 1. Fetch both tables for the date
  const jobsQ = pool.query<JobRow>(
    `SELECT id, do_number, customer_name, phone, delivery_address, postcode, city, state,
            scheduled_date::text, special_instructions, status, latitude, longitude, geocode_status
     FROM jobs
     WHERE scheduled_date = $1`,
    [date],
  );
  const collectionsQ = pool.query<CollectionRow>(
    `SELECT id, do_number, recipient_name, recipient_phone, collection_address, postcode, city, state,
            scheduled_date::text, special_instructions, status, time_window, latitude, longitude, geocode_status
     FROM collections
     WHERE scheduled_date = $1`,
    [date],
  );

  const [{ rows: jobs }, { rows: collections }] = await Promise.all([jobsQ, collectionsQ]);

  // 2. Identify rows needing geocoding (no lat/lng AND never attempted)
  type GeoTarget =
    | { kind: "job"; row: JobRow; address: string }
    | { kind: "collection"; row: CollectionRow; address: string };

  const targets: GeoTarget[] = [];

  for (const job of jobs) {
    if (job.latitude != null && job.longitude != null) continue;
    if (job.geocode_status === "failed") continue; // don't retry failures automatically
    const address = buildGeocodeAddress({
      base: job.delivery_address,
      city: job.city,
      state: job.state,
      postcode: job.postcode,
    });
    if (address) targets.push({ kind: "job", row: job, address });
  }
  for (const col of collections) {
    if (col.latitude != null && col.longitude != null) continue;
    if (col.geocode_status === "failed") continue;
    const address = buildGeocodeAddress({
      base: col.collection_address,
      city: col.city,
      state: col.state,
      postcode: col.postcode,
    });
    if (address) targets.push({ kind: "collection", row: col, address });
  }

  // 3. Geocode missing ones with concurrency control
  if (targets.length > 0) {
    logger.info({ count: targets.length, date }, "geocoding new stops");
    const results = await geocodeBatch(targets, (t) => t.address, 5);

    // 4. Persist results back to DB
    const updatePromises: Promise<unknown>[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const result = results.get(i) ?? null;

      if (result) {
        if (target.kind === "job") {
          target.row.latitude = result.lat;
          target.row.longitude = result.lng;
          target.row.geocode_status = "success";
          updatePromises.push(
            pool.query(
              `UPDATE jobs SET latitude = $1, longitude = $2, geocoded_at = NOW(),
                               geocode_status = 'success', geocoded_address = $3
               WHERE id = $4`,
              [result.lat, result.lng, result.matchedAddress, target.row.id],
            ),
          );
        } else {
          target.row.latitude = result.lat;
          target.row.longitude = result.lng;
          target.row.geocode_status = "success";
          updatePromises.push(
            pool.query(
              `UPDATE collections SET latitude = $1, longitude = $2, geocoded_at = NOW(),
                                       geocode_status = 'success', geocoded_address = $3
               WHERE id = $4`,
              [result.lat, result.lng, result.matchedAddress, target.row.id],
            ),
          );
        }
      } else {
        if (target.kind === "job") {
          target.row.geocode_status = "failed";
          updatePromises.push(
            pool.query(
              `UPDATE jobs SET geocoded_at = NOW(), geocode_status = 'failed' WHERE id = $1`,
              [target.row.id],
            ),
          );
        } else {
          target.row.geocode_status = "failed";
          updatePromises.push(
            pool.query(
              `UPDATE collections SET geocoded_at = NOW(), geocode_status = 'failed' WHERE id = $1`,
              [target.row.id],
            ),
          );
        }
      }
    }
    await Promise.all(updatePromises);
    logger.info({ count: targets.length, date }, "geocoding finished");
  }

  // 5. Merge into unified stop list
  const stops: StopPublic[] = [];

  for (const job of jobs) {
    stops.push({
      id: `STP-J${job.id}`,
      source: "job",
      sourceId: job.id,
      orderRef: job.do_number ?? `JOB-${job.id}`,
      customerName: job.customer_name ?? "",
      phone: job.phone ?? "",
      address: job.delivery_address ?? "",
      postcode: job.postcode ?? "",
      city: job.city ?? "",
      state: job.state ?? "",
      lat: job.latitude,
      lng: job.longitude,
      jobType: "Delivery",
      window: "",
      status: job.status ?? "pending",
      date: job.scheduled_date ?? date,
      notes: job.special_instructions ?? "",
      geocodeFailed: job.geocode_status === "failed",
    });
  }

  for (const col of collections) {
    stops.push({
      id: `STP-C${col.id}`,
      source: "collection",
      sourceId: col.id,
      orderRef: col.do_number ?? `COL-${col.id}`,
      customerName: col.recipient_name ?? "",
      phone: col.recipient_phone ?? "",
      address: col.collection_address ?? "",
      postcode: col.postcode ?? "",
      city: col.city ?? "",
      state: col.state ?? "",
      lat: col.latitude,
      lng: col.longitude,
      jobType: "Collection",
      window: col.time_window ?? "",
      status: col.status ?? "pending",
      date: col.scheduled_date ?? date,
      notes: col.special_instructions ?? "",
      geocodeFailed: col.geocode_status === "failed",
    });
  }

  // Stable order: collections first, then jobs, then by source id
  stops.sort((a, b) => {
    if (a.source !== b.source) return a.source === "collection" ? -1 : 1;
    return a.sourceId - b.sourceId;
  });

  return stops;
}
import { env } from "../config/env.js";
import {
  DIRECTIONS_MASK,
  GOOGLE_REQUEST_TIMEOUT_MS,
  GOOGLE_ROUTES_BASE,
  MATRIX_MASK,
} from "../config/constants.js";
import { logger } from "../utils/logger.js";
import { ApiError } from "../types/api.types.js";
import type { RouteJob, RoutePoint } from "../types/route.types.js";

/**
 * Low-level wrappers around Google Routes API.
 * - Accepts explicit origin/destination (for chained multi-request routes)
 * - Adds API key, timeouts, and friendly error translation
 * - Never touches business logic
 */

interface CallOptions {
  path: "directions/v2:computeRoutes" | "distanceMatrix/v2:computeRouteMatrix";
  payload: unknown;
  fieldMask: string;
}

async function callRoutesApi<T>({ path, payload, fieldMask }: CallOptions): Promise<T> {
  const url = `${GOOGLE_ROUTES_BASE}/${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? "Google Routes API timed out"
        : err instanceof Error
          ? err.message
          : "Network error contacting Google Routes API";
    logger.error({ err }, "Google Routes network error");
    throw new ApiError(504, "GOOGLE_TIMEOUT", message);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.error({ status: response.status, body: text.slice(0, 500) }, "Google Routes error");

    let message = "Google Routes request failed";
    if (text.includes("API_KEY_INVALID")) message = "Google Maps API key is invalid";
    else if (text.includes("API_KEY_SERVICE_BLOCKED"))
      message = "Enable Routes API on this key in Google Cloud Console";
    else if (text.includes("API_KEY_HTTP_REFERRER_BLOCKED"))
      message = "Server key must not have HTTP referrer restrictions. Use Application restrictions = None or IP addresses.";
    else if (text.includes("API_KEY_EXPIRED")) message = "Google Maps API key has expired";
    else if (response.status === 429)
      message = "Google Routes API quota exceeded. Check your Google Cloud quotas.";
    else if (response.status >= 500)
      message = "Google Routes API is temporarily unavailable";

    throw new ApiError(
      response.status === 429 ? 429 : 502,
      "GOOGLE_ROUTES_FAILED",
      message,
      { status: response.status, body: text.slice(0, 500) },
    );
  }

  return (await response.json()) as T;
}

/** Payload builder — accepts explicit origin + destination. */
function buildDirectionsBody(origin: RoutePoint, destination: RoutePoint, jobs: RouteJob[], optimize: boolean) {
  if (jobs.length > 25) {
    throw new ApiError(500, "SPLIT_BUG", `Internal: chunk size ${jobs.length} exceeds Google limit`);
  }
  const waypoint = (p: RoutePoint) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
      throw new ApiError(500, "INVALID_COORD", "Invalid location in chunk");
    }
    return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
  };
  return {
    origin: waypoint(origin),
    destination: waypoint(destination),
    intermediates: jobs.map((j) => waypoint(j.position)),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_UNAWARE",
    optimizeWaypointOrder: optimize && jobs.length > 1,
    polylineQuality: "HIGH_QUALITY",
  };
}

/** Round trip (or open chain segment) with explicit origin/destination. */
export async function computeSegment(
  origin: RoutePoint,
  destination: RoutePoint,
  jobs: RouteJob[],
  optimize: boolean,
): Promise<unknown> {
  return callRoutesApi({
    path: "directions/v2:computeRoutes",
    payload: buildDirectionsBody(origin, destination, jobs, optimize),
    fieldMask: DIRECTIONS_MASK,
  });
}

/** Distance matrix from one depot to N jobs (used for nearest-job anchoring). */
export async function computeDepotDistances(depot: RoutePoint, jobs: RouteJob[]): Promise<unknown> {
  const waypoint = (p: RoutePoint) => ({
    location: { latLng: { latitude: p.lat, longitude: p.lng } },
  });
  return callRoutesApi({
    path: "distanceMatrix/v2:computeRouteMatrix",
    payload: {
      origins: [{ waypoint: waypoint(depot) }],
      destinations: jobs.map((j) => ({ waypoint: waypoint(j.position) })),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
    },
    fieldMask: MATRIX_MASK,
  });
}
/** Fixed-order driving route with non-stopover pass-through points. */
export async function computeViaSegment(origin: RoutePoint, destination: RoutePoint, nodes: {position:RoutePoint;via:boolean}[]): Promise<unknown> {
 if(nodes.length>25) throw new ApiError(400,"TOO_MANY_WAYPOINTS","Too many routing points in one segment.");
 const waypoint=(p:RoutePoint)=>({location:{latLng:{latitude:p.lat,longitude:p.lng}}});
 return callRoutesApi({path:"directions/v2:computeRoutes",fieldMask:DIRECTIONS_MASK,payload:{
  origin:waypoint(origin),destination:waypoint(destination),
  intermediates:nodes.map(node=>({...waypoint(node.position),...(node.via?{via:true}:{})})),
  travelMode:"DRIVE",routingPreference:"TRAFFIC_UNAWARE",optimizeWaypointOrder:false,polylineQuality:"HIGH_QUALITY",
 }});
}

// Google Routes API hard limits
export const GOOGLE_MAX_WAYPOINTS_PER_REQUEST = 25;

// Overall sanity guard — reject absurd payloads (protects server memory)
// This is NOT a user-facing cap; set high enough that no realistic route hits it.
export const MAX_JOBS_PER_PLAN = 1000;

// Request body size guard
export const MAX_REQUEST_BODY_BYTES = 2_000_000; // 2 MB

export const ROUTE_CACHE_KEY_SEPARATOR = "::";

export const API_VERSION = "v1";

export const GOOGLE_ROUTES_BASE = "https://routes.googleapis.com";
export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;

// Field mask used for both directions calls (split chunks)
export const DIRECTIONS_MASK =
  "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline," +
  "routes.legs.duration,routes.legs.distanceMeters,routes.optimizedIntermediateWaypointIndex";

export const MATRIX_MASK =
  "originIndex,destinationIndex,status,condition,distanceMeters";
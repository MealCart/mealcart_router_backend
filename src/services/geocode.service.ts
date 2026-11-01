import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { ApiError } from "../types/api.types.js";

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const REQUEST_TIMEOUT_MS = 10_000;

export interface GeocodeResult {
  lat: number;
  lng: number;
  matchedAddress: string;
}

/**
 * Geocode a single address string using Google Geocoding API.
 * Returns null when Google has no match (address is bad/ambiguous).
 * Throws ApiError only on configuration/network/API-key problems.
 */
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const trimmed = address.trim();
  if (!trimmed) return null;

  // Always ensure country context
  const query = /australia/i.test(trimmed) ? trimmed : `${trimmed}, Australia`;

  const url =
    `${GEOCODE_URL}?address=${encodeURIComponent(query)}` +
    `&region=au&key=${encodeURIComponent(env.GOOGLE_MAPS_API_KEY)}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    logger.error({ err, address: trimmed }, "Geocoding network error");
    throw new ApiError(504, "GEOCODE_TIMEOUT", "Geocoding request timed out");
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.error({ status: response.status, body: text.slice(0, 300) }, "Geocoding HTTP error");
    throw new ApiError(502, "GEOCODE_FAILED", "Geocoding request failed");
  }

  const data = (await response.json()) as {
    status: string;
    results?: Array<{
      formatted_address: string;
      geometry: { location: { lat: number; lng: number } };
    }>;
  };

  if (data.status === "ZERO_RESULTS") return null;

  if (data.status !== "OK") {
    logger.error({ status: data.status, address: trimmed }, "Geocoding API returned non-OK");
    throw new ApiError(502, "GEOCODE_FAILED", `Geocoding API: ${data.status}`);
  }

  const first = data.results?.[0];
  if (!first) return null;

  return {
    lat: first.geometry.location.lat,
    lng: first.geometry.location.lng,
    matchedAddress: first.formatted_address,
  };
}

/**
 * Run geocodeAddress over a list with concurrency control.
 * Returns results in the same order as input.
 */
export async function geocodeBatch<T>(
  items: T[],
  getAddress: (item: T) => string,
  concurrency = 5,
): Promise<Map<number, GeocodeResult | null>> {
  const results = new Map<number, GeocodeResult | null>();
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      try {
        const result = await geocodeAddress(getAddress(item));
        results.set(index, result);
      } catch (err) {
        logger.warn({ err, index }, "Geocode failed for one item");
        results.set(index, null);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
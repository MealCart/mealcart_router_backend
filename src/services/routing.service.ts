import { stitchPolylines } from "../lib/route-geometry.js";
import { planViaRoute } from "./via-route.service.js";
import { ApiError } from "../types/api.types.js";
import type { RoadRoute, RoadRouteLeg, RouteJob, RoutePoint, RouteViaPoint } from "../types/route.types.js";
import { computeDepotDistances, computeSegment } from "./google-routes.service.js";
import { cacheGet, cacheKey, cacheSet } from "./route-cache.service.js";
import { decodeRoutePolyline, nearestDepotJob } from "../lib/road-route.js";
import { GOOGLE_MAX_WAYPOINTS_PER_REQUEST } from "../config/constants.js";
import { logger } from "../utils/logger.js";

export interface PlanRouteInput {
  depot: RoutePoint;
  jobs: RouteJob[];
  optimize: boolean;
  viaPoints?: RouteViaPoint[];
}

interface ParsedSegment {
  /** Optimized intermediate job IDs (order in which they're visited). */
  orderedIntermediateJobIds: string[];
  /** If set, this job appears as the destination of this segment (last leg). */
  destinationJobId: string | null;
  legs: RoadRouteLeg[];
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
}

export async function planRoute(input: PlanRouteInput): Promise<RoadRoute> {
  const key = cacheKey("plan", input);
  const cached = cacheGet<RoadRoute>(key);
  if (cached) {
    logger.debug({ jobCount: input.jobs.length }, "route cache hit");
    return cached;
  }

  if (input.viaPoints?.length) {
    if (input.optimize) throw new ApiError(400,"VIA_ORDER_FIXED","Road edits require the current fixed delivery order.");
    const edited = await planViaRoute(input.depot,input.jobs,input.viaPoints);
    cacheSet(key,edited); return edited;
  }
  const { depot, jobs, optimize } = input;

  // Nearest-job anchor (only affects the order within the first chunk)
  let nearestId: string | undefined;
  if (optimize && jobs.length > 1) {
    const cells = await computeDepotDistances(depot, jobs);
    if (!Array.isArray(cells)) {
      throw new ApiError(502, "GOOGLE_MATRIX_FAILED", "Missing depot distances");
    }
    nearestId = nearestDepotJob(cells, jobs);
  }

  // Rotate jobs so nearest is first (only when single-chunk, because multi-chunk
  // optimization can't guarantee the nearest job is in chunk 1's scope anyway)
  let workingJobs = jobs;
  if (nearestId && jobs.length > 1 && jobs.length <= GOOGLE_MAX_WAYPOINTS_PER_REQUEST) {
    const idx = jobs.findIndex((j) => j.id === nearestId);
    if (idx > 0) {
      workingJobs = [jobs[idx], ...jobs.slice(0, idx), ...jobs.slice(idx + 1)];
    }
  }

  // Chunk into groups of ≤25
  const chunks: RouteJob[][] = [];
  for (let i = 0; i < workingJobs.length; i += GOOGLE_MAX_WAYPOINTS_PER_REQUEST) {
    chunks.push(workingJobs.slice(i, i + GOOGLE_MAX_WAYPOINTS_PER_REQUEST));
  }

  logger.info(
    { totalJobs: jobs.length, chunks: chunks.length, optimize },
    chunks.length > 1 ? "splitting route into chunks" : "single-chunk route",
  );

  const allLegs: RoadRouteLeg[] = [];
  const allJobIds: string[] = [];
  let totalDistance = 0;
  let totalDuration = 0;
  const polylineParts: string[] = [];

  let currentOrigin: RoutePoint = depot;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunkJobs = chunks[chunkIndex];
    const isLastChunk = chunkIndex === chunks.length - 1;

    let segment: ParsedSegment;

    if (isLastChunk) {
      // Last chunk: all jobs are intermediates, destination is depot.
      // Result legs: origin → j1 → ... → jN → depot = N + 1 legs.
      segment = await computeAndParseSegment({
        origin: currentOrigin,
        destination: depot,
        intermediates: chunkJobs,
        optimize,
        destinationJobId: null,
      });
    } else {
      // Non-last chunk: last job is the destination.
      // Result legs: origin → j1 → ... → j(N-1) → destination = N legs.
      // The destination becomes the next chunk's origin.
      const destinationJob = chunkJobs[chunkJobs.length - 1];
      const intermediateJobs = chunkJobs.slice(0, -1);
      segment = await computeAndParseSegment({
        origin: currentOrigin,
        destination: destinationJob.position,
        intermediates: intermediateJobs,
        optimize,
        destinationJobId: destinationJob.id,
      });
      // Next chunk starts at this destination
      currentOrigin = destinationJob.position;
    }

    // Accumulate
    allJobIds.push(...segment.orderedIntermediateJobIds);
    if (segment.destinationJobId !== null) {
      allJobIds.push(segment.destinationJobId);
    }
    allLegs.push(...segment.legs);
    totalDistance += segment.distanceMeters;
    totalDuration += segment.durationSeconds;
    polylineParts.push(segment.encodedPolyline);

    logger.debug(
      {
        chunk: chunkIndex + 1,
        of: chunks.length,
        jobsInChunk: chunkJobs.length,
        legsThisChunk: segment.legs.length,
        destination: segment.destinationJobId ?? "depot",
        totalJobIdsSoFar: allJobIds.length,
        totalLegsSoFar: allLegs.length,
      },
      "segment assembled",
    );
  }

  const finalRoute: RoadRoute = {
    jobIds: allJobIds,
    distanceMeters: totalDistance,
    durationSeconds: totalDuration,
    encodedPolyline: stitchPolylines(polylineParts),
    legs: allLegs,
  };

  // Sanity checks with detailed diagnostics
  if (finalRoute.jobIds.length !== jobs.length) {
    logger.error(
      {
        expectedJobs: jobs.length,
        actualJobs: finalRoute.jobIds.length,
        chunks: chunks.length,
        jobIds: finalRoute.jobIds,
      },
      "jobIds count mismatch",
    );
    throw new ApiError(
      500,
      "CHAIN_MISMATCH",
      `Route assembly failed: expected ${jobs.length} jobs, got ${finalRoute.jobIds.length}`,
    );
  }
  if (finalRoute.legs.length !== jobs.length + 1) {
    logger.error(
      {
        expectedLegs: jobs.length + 1,
        actualLegs: finalRoute.legs.length,
        chunks: chunks.length,
        chunkSizes: chunks.map((c) => c.length),
        legsPerChunk: "see segment assembled logs above",
      },
      "legs count mismatch",
    );
    throw new ApiError(
      500,
      "CHAIN_MISMATCH",
      `Route assembly failed: expected ${jobs.length + 1} legs, got ${finalRoute.legs.length}`,
    );
  }
  const jobIdSet = new Set(finalRoute.jobIds);
  if (jobIdSet.size !== jobs.length) {
    logger.error({ total: finalRoute.jobIds.length, unique: jobIdSet.size }, "duplicate job IDs");
    throw new ApiError(500, "CHAIN_MISMATCH", "Route assembly failed: duplicate job IDs");
  }

  cacheSet(key, finalRoute);
  return finalRoute;
}

async function computeAndParseSegment({
  origin,
  destination,
  intermediates,
  optimize,
  destinationJobId,
}: {
  origin: RoutePoint;
  destination: RoutePoint;
  intermediates: RouteJob[];
  optimize: boolean;
  destinationJobId: string | null;
}): Promise<ParsedSegment> {
  if (intermediates.length > GOOGLE_MAX_WAYPOINTS_PER_REQUEST) {
    throw new ApiError(500, "SPLIT_BUG", `Chunk size ${intermediates.length} exceeds Google limit`);
  }

  const response = await computeSegment(origin, destination, intermediates, optimize);
  const route = (response as any)?.routes?.[0];
  if (!route) throw new ApiError(502, "NO_ROUTE", "No road route found for these locations");

  const duration = (value: unknown) => {
    if (typeof value !== "string" || !/^\d+(\.\d+)?s$/.test(value)) {
      throw new ApiError(502, "BAD_DURATION", "Missing route travel time");
    }
    return Number(value.slice(0, -1));
  };
  const distance = (value: unknown) => {
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ApiError(502, "BAD_DISTANCE", "Invalid route distance");
    }
    return value;
  };

  const returnedOrder = route.optimizedIntermediateWaypointIndex;
  const singleStopOrder =
    intermediates.length === 1 &&
    (returnedOrder == null || (Array.isArray(returnedOrder) && returnedOrder.length === 0));

  let order: number[];
  if (optimize) {
    order = singleStopOrder ? [0] : returnedOrder;
  } else {
    order = intermediates.map((_, i) => i);
  }

  if (
    !Array.isArray(order) ||
    order.length !== intermediates.length ||
    new Set(order).size !== intermediates.length ||
    order.some((i) => !Number.isInteger(i) || i < 0 || i >= intermediates.length)
  ) {
    logger.error(
      { intermediateCount: intermediates.length, optimize, returnedOrder },
      "invalid optimized order",
    );
    throw new ApiError(502, "BAD_ORDER", "Incomplete optimized job order");
  }

  if (!Array.isArray(route.legs) || route.legs.length !== intermediates.length + 1) {
    throw new ApiError(
      502,
      "BAD_LEGS",
      `Incomplete segment: expected ${intermediates.length + 1} legs, got ${route.legs?.length ?? 0}`,
    );
  }

  const encodedPolyline = route.polyline?.encodedPolyline;
  if (typeof encodedPolyline !== "string") {
    throw new ApiError(502, "NO_GEOMETRY", "Missing route geometry");
  }
  decodeRoutePolyline(encodedPolyline);

  return {
    orderedIntermediateJobIds: order.map((i) => intermediates[i].id),
    destinationJobId,
    legs: route.legs.map((leg: any) => ({
      durationSeconds: duration(leg.duration),
      distanceMeters: distance(leg.distanceMeters),
    })),
    distanceMeters: distance(route.distanceMeters),
    durationSeconds: duration(route.duration),
    encodedPolyline,
  };
}
import type { RoutePoint, RouteJob, RoadRoute } from "../types/route.types.js";
export type { RoutePoint, RouteJob, RoadRoute };

export function moveJob(ids: string[], id: string, sequence: number) {
  if (!ids.includes(id) || !Number.isInteger(sequence) || sequence < 1 || sequence > ids.length) {
    throw new Error(`Sequence must be between 1 and ${ids.length}`);
  }
  const next = ids.filter(value => value !== id);
  next.splice(sequence - 1, 0, id);
  return next;
}

export function routeSchedule(route: RoadRoute, startTime: string, prepMinutes: number, stopMinutes: number) {
  const [hours, minutes] = startTime.split(":").map(Number);
  let seconds = (hours * 60 + minutes + prepMinutes) * 60;
  const arrivals = route.jobIds.map((id, index) => {
    seconds += route.legs[index].durationSeconds;
    const arrivalSeconds = seconds;
    seconds += stopMinutes * 60;
    return { id, arrivalSeconds, travelSeconds: route.legs[index].durationSeconds };
  });
  seconds += route.legs[route.legs.length - 1].durationSeconds;
  return { arrivals, finishSeconds: seconds };
}

export function decodeRoutePolyline(encoded: string): RoutePoint[] {
  let index = 0, lat = 0, lng = 0;
  const points: RoutePoint[] = [];
  const read = () => {
    let result = 0, shift = 0, byte = 0;
    do {
      if (index >= encoded.length || shift > 30) throw new Error("Invalid route geometry");
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error("Invalid route geometry");
      result |= (byte & 31) << shift; shift += 5;
    } while (byte >= 32);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += read();
    lng += read();
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  if (points.length < 2) throw new Error("Missing route geometry");
  return points;
}

export function buildRoundTrip(depot: RoutePoint, jobs: RouteJob[], optimize: boolean) {
  if (!jobs.length || jobs.length > 25 || new Set(jobs.map(j => j.id)).size !== jobs.length) {
    throw new Error("Choose between 1 and 25 unique jobs");
  }
  const waypoint = (p: RoutePoint) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
      throw new Error("Invalid location");
    }
    return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
  };
  return {
    origin: waypoint(depot),
    destination: waypoint(depot),
    intermediates: jobs.map(j => waypoint(j.position)),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_UNAWARE",
    optimizeWaypointOrder: optimize && jobs.length > 1,
    polylineQuality: "HIGH_QUALITY",
  };
}

export function nearestDepotJob(cells: any[], jobs: RouteJob[]): string {
  const distances = new Map<number, number>();
  for (const cell of cells) {
    const index = cell.destinationIndex ?? 0;
    const meters = cell.distanceMeters ?? 0;
    if (
      (cell.originIndex ?? 0) !== 0 ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= jobs.length ||
      distances.has(index) ||
      cell.status?.code ||
      cell.condition !== "ROUTE_EXISTS" ||
      typeof meters !== "number" ||
      !Number.isFinite(meters) ||
      meters < 0
    ) {
      throw new Error("Cannot determine the nearest depot job");
    }
    distances.set(index, meters);
  }
  if (distances.size !== jobs.length) throw new Error("Incomplete depot distances");
  const nearest = jobs.reduce(
    (best, _, index) => (distances.get(index) ?? Infinity) < (distances.get(best) ?? Infinity) ? index : best,
    0,
  );
  const job = jobs[nearest];
  if (!job) throw new Error("No depot jobs found");
  return job.id;
}

export function startWithNearest(ids: string[], nearestId: string): string[] {
  const index = ids.indexOf(nearestId);
  if (index < 0) throw new Error("Nearest job missing from route");
  return [...ids.slice(index), ...ids.slice(0, index)];
}

export function parseRoadRoute(data: any, jobs: RouteJob[], optimized: boolean): RoadRoute {
  const route = data?.routes?.[0];
  if (!route) throw new Error("No road route found for these locations");

  const duration = (value: unknown) => {
    if (typeof value !== "string" || !/^\d+(\.\d+)?s$/.test(value)) {
      throw new Error("Missing route travel time");
    }
    return Number(value.slice(0, -1));
  };
  const distance = (value: unknown) => {
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("Invalid route distance");
    }
    return value;
  };

  const returnedOrder = route.optimizedIntermediateWaypointIndex;
  // A single stop has exactly one order, even when the provider returns an empty array.
  const singleStopOrder =
    jobs.length === 1 &&
    (returnedOrder == null || (Array.isArray(returnedOrder) && returnedOrder.length === 0));
  const order: number[] = optimized
    ? singleStopOrder
      ? [0]
      : returnedOrder
    : jobs.map((_, i) => i);

  if (
    !Array.isArray(order) ||
    order.length !== jobs.length ||
    new Set(order).size !== jobs.length ||
    order.some(i => !Number.isInteger(i) || i < 0 || i >= jobs.length)
  ) {
    console.error("Invalid optimized order", { jobCount: jobs.length, optimized, returnedOrder });
    throw new Error("Incomplete optimized job order");
  }

  if (!Array.isArray(route.legs) || route.legs.length !== jobs.length + 1) {
    throw new Error("Incomplete depot round trip");
  }

  const encodedPolyline = route.polyline?.encodedPolyline;
  if (typeof encodedPolyline !== "string") throw new Error("Missing route geometry");
  decodeRoutePolyline(encodedPolyline);

  return {
    jobIds: order.map(i => jobs[i].id),
    distanceMeters: distance(route.distanceMeters),
    durationSeconds: duration(route.duration),
    encodedPolyline,
    legs: route.legs.map((leg: any) => ({
      durationSeconds: duration(leg.duration),
      distanceMeters: distance(leg.distanceMeters),
    })),
  };
}
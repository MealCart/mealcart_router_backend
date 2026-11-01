export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface RouteJob {
  id: string;
  address: string;
  position: RoutePoint;
}

export interface RoadRouteLeg {
  durationSeconds: number;
  distanceMeters: number;
}

export interface RoadRoute {
  jobIds: string[];
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
  legs: RoadRouteLeg[];
  viaPoints?: RouteViaPoint[];
}

export interface PlanRouteRequest {
  depot: RoutePoint;
  jobs: RouteJob[];
  optimize: boolean;
}
export interface RouteViaPoint { id: string; beforeJobId: string | null; position: RoutePoint; }

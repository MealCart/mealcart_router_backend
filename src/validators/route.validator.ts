import { z } from "zod";
import { MAX_JOBS_PER_PLAN } from "../config/constants.js";

const latSchema = z.number().finite().min(-90).max(90);
const lngSchema = z.number().finite().min(-180).max(180);

const pointSchema = z.object({
  lat: latSchema,
  lng: lngSchema,
});

const jobSchema = z.object({
  id: z.string().min(1).max(100),
  address: z.string().min(1).max(500),
  position: pointSchema,
});

export const viaPointSchema = z.object({
 id: z.string().min(1).max(100), beforeJobId: z.string().min(1).max(100).nullable(), position: pointSchema,
}).strict();
export const viaPointsSchema = z.array(viaPointSchema).max(10).refine(v => new Set(v.map(p => p.id)).size === v.length, "Via IDs must be unique");
export const planRouteSchema = z.object({
  depot: pointSchema,
  jobs: z
    .array(jobSchema)
    .min(1, "At least 1 job required")
    .max(MAX_JOBS_PER_PLAN, `Too many jobs (max ${MAX_JOBS_PER_PLAN})`),
  optimize: z.boolean(),
  viaPoints: viaPointsSchema.default([]),
});

export type PlanRouteInput = z.infer<typeof planRouteSchema>;

export const distanceMatrixSchema = z.object({
  depot: pointSchema,
  jobs: z
    .array(jobSchema)
    .min(1)
    .max(MAX_JOBS_PER_PLAN),
});

export type DistanceMatrixInput = z.infer<typeof distanceMatrixSchema>;
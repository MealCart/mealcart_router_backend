import { viaPointsSchema } from "./route.validator.js";
import { z } from "zod";

const legSchema = z.object({
  durationSeconds: z.number().nonnegative(),
  distanceMeters: z.number().nonnegative(),
});

const stopArrivalSchema = z.object({
  stopId: z.string().min(1).max(100),
  seq: z.number().int().positive(),
  arrivalSecondsFromMidnight: z.number().nonnegative(),
  travelSecondsFromPrev: z.number().nonnegative(),
  distanceMetersFromPrev: z.number().nonnegative(),
  cumulativeDistanceMeters: z.number().nonnegative(),
  cumulativeDurationSeconds: z.number().nonnegative(),
});

const routePlanBase = z.object({
  driverId: z.string().min(1).max(40),
  planDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  status: z.enum(["Draft", "Planned"]).default("Planned"),
  distanceMeters: z.number().int().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
  encodedPolyline: z.string().min(1),
  jobIds: z.array(z.string().min(1).max(100)).min(1),
  legs: z.array(legSchema).min(1),
  stopArrivals: z.array(stopArrivalSchema).min(1),
  manual: z.boolean().default(false),
  viaPoints: viaPointsSchema.default([]),
});

function checkRoute(v:z.infer<typeof routePlanBase>,ctx:z.RefinementCtx){
 const ids=v.jobIds;
 if(new Set(ids).size!==ids.length||v.legs.length!==ids.length+1||v.stopArrivals.length!==ids.length+1||
 v.stopArrivals.some((s,i)=>s.seq!==i+1||s.stopId!==(ids[i]??"__DEPOT__"))||
 v.viaPoints.some(p=>p.beforeJobId!==null&&!ids.includes(p.beforeJobId)))ctx.addIssue({code:z.ZodIssueCode.custom,message:"Route stops, legs or via points do not match."});
}
export const createRoutePlanSchema=routePlanBase.superRefine(checkRoute);
export const updateRouteRoadsSchema=routePlanBase.extend({version:z.number().int().positive()}).superRefine(checkRoute);
export type CreateRoutePlanInput = z.infer<typeof createRoutePlanSchema>;

export const deleteByDateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
});
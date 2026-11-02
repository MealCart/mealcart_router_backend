import {z} from 'zod';
export const trackingSessionSchema=z.object({sessionId:z.string().uuid()}).strict();
export const trackingPointSchema=trackingSessionSchema.extend({sampleId:z.string().uuid(),lat:z.number().finite().min(-90).max(90),lng:z.number().finite().min(-180).max(180),accuracy:z.number().finite().min(0).max(1000),speed:z.number().finite().min(0).max(100).nullable(),heading:z.number().finite().min(0).lt(360).nullable(),capturedAt:z.string().datetime()}).strict();
export type TrackingPoint= z.infer<typeof trackingPointSchema>;

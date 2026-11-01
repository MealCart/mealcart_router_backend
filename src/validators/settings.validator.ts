import { z } from "zod";
export const routeSettingsSchema = z.object({
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Start time must be HH:MM in 24-hour format"),
  stopDuration: z.number().int().min(0).max(1440),
  version: z.number().int().positive(),
}).strict();
export type RouteSettingsInput = z.infer<typeof routeSettingsSchema>;

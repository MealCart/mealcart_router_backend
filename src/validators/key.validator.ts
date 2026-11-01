import { z } from "zod";
export const registerKeySchema = z.object({
 name: z.string().trim().min(1).max(100),
 customerId: z.string().regex(/^[1-9]\d*$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) <= 2147483647),
 notes: z.string().trim().max(2000).default(""),
}).strict();
export const keyMovementSchema = z.object({
 version: z.number().int().positive(),
 issueId: z.string().uuid(),
 notes: z.string().trim().max(2000).default(""),
}).strict();
export const issueKeySchema = z.object({
 version: z.number().int().positive(),
 driverId: z.string().min(1).max(40),
 notes: z.string().trim().max(2000).default(""),
}).strict();
export type RegisterKeyInput = z.infer<typeof registerKeySchema>;
export type KeyMovementInput = z.infer<typeof keyMovementSchema>;
export type IssueKeyInput = z.infer<typeof issueKeySchema>;

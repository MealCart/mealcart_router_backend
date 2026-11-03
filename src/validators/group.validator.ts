import { z } from "zod";
export const deliveryEvents = ["Scheduled Delivery Reminder", "Delivery Today — 7 AM", "Delivery Tomorrow — 8 PM", "Delivery ETA — One Hour", "Delivery Scheduled", "Driver Assigned", "Driver Started Route", "Driver En Route to Customer", "Delivery Arriving Soon", "Delivery Completed", "Delivery Failed", "Delivery Rescheduled", "Order Cancelled"] as const;
const unique = (values: string[]) => new Set(values).size === values.length;
const userId = z.string().regex(/^[1-9]\d*$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) <= 2147483647, "Invalid customer ID");
const groupFields = {
 name: z.string().trim().min(1).max(120),
 description: z.string().max(2000).default(""),
 contact: z.enum(["SMS", "Email"]),
 status: z.enum(["Active", "Inactive"]),
 recordTemperature: z.boolean(),
 memberIds: z.array(userId).max(10000).refine(unique, "Duplicate members"),
 templateIds: z.array(z.string().min(1).max(40)).max(200).refine(unique, "Duplicate templates"),
};
export const createGroupSchema = z.object(groupFields).strict();
export const updateGroupSchema = z.object({ ...groupFields, version: z.number().int().positive() }).strict();
export type GroupInput = z.infer<typeof createGroupSchema>;
export const templateSchema = z.object({
 groupIds: z.array(z.string().min(1).max(40)).max(10000).refine(unique, "Duplicate groups").optional(),
 groupVersions: z.record(z.string().min(1).max(40), z.number().int().positive()).optional(),
 name: z.string().trim().min(1).max(120), description: z.string().max(2000).default(""),
 channel: z.enum(["SMS", "Email", "Both"]), event: z.enum(deliveryEvents),
 subject: z.string().max(500).default(""), body: z.string().trim().min(1).max(10000),
 status: z.enum(["Active", "Inactive"]),
}).strict().superRefine((value, ctx) => {
 if (value.groupIds !== undefined && !value.groupVersions) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groupVersions"], message: "Refresh the group list before saving assignments" });
 if (value.channel !== "SMS" && !value.subject.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subject"], message: "Email subject is required" });
});
export type TemplateInput = z.infer<typeof templateSchema>;

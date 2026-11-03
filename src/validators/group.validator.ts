import { z } from "zod";
export const deliveryEvents = ["Scheduled Delivery Reminder", "Delivery ETA — One Hour", "Delivery Failed", "Delivery Completed"] as const;
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
 name: z.string().trim().min(1).max(120), description: z.string().max(2000).default(""),
 channel: z.enum(["SMS", "Email", "Both"]), event: z.enum(deliveryEvents),
 subject: z.string().max(500).default(""), body: z.string().trim().min(1).max(10000),
 status: z.enum(["Active", "Inactive"]),
 daysBefore: z.number().int().min(0).max(60).nullable().optional(),
 sendTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
}).strict().superRefine((value, ctx) => {
 if(value.event==='Scheduled Delivery Reminder'){
  if(value.daysBefore==null)ctx.addIssue({code:z.ZodIssueCode.custom,path:['daysBefore'],message:'Days before delivery is required'});
  if(!value.sendTime)ctx.addIssue({code:z.ZodIssueCode.custom,path:['sendTime'],message:'Reminder send time is required'});
 }else if(value.daysBefore!=null||value.sendTime!=null)ctx.addIssue({code:z.ZodIssueCode.custom,path:['event'],message:'Timing applies only to Scheduled Delivery Reminder'});
 if (value.channel !== "SMS" && !value.subject.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subject"], message: "Email subject is required" });
});
export type TemplateInput = z.infer<typeof templateSchema>;

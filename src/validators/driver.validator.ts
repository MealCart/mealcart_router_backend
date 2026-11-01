import { z } from "zod";

const availabilityEnum = z.enum(["Available", "On Route", "Off Duty"]);
const statusEnum = z.enum(["Active", "Inactive"]);

export const createDriverSchema = z.object({
  password: z.string().min(8,"Use at least 8 characters").max(72).refine(v=>Buffer.byteLength(v,"utf8")<=72,"Use at most 72 UTF-8 bytes"),
  name: z.string().trim().min(1, "Full name is required").max(120),
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters")
    .max(60)
    .regex(/^[a-z0-9._-]+$/i, "Only letters, numbers, dots, dashes"),
  phone: z.string().trim().min(1, "Phone is required").max(40),
  email: z.string().trim().email("Invalid email").max(200),
  depotId: z.string().trim().min(1).max(40).nullable(),
  availability: availabilityEnum,
  status: statusEnum,
  maxStops: z.coerce.number().int().min(1).max(200),
});

export const updateDriverSchema = createDriverSchema.partial();

export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;
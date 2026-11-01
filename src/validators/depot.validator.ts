import { z } from "zod";

const statusEnum = z.enum(["Active", "Inactive"]);

export const createDepotSchema = z.object({
  name: z.string().trim().min(1, "Depot name is required").max(120),
  address: z.string().trim().min(1, "Address is required").max(200),
  city: z.string().trim().min(1, "City is required").max(120),
  description: z.string().max(500).default(""),
  status: statusEnum.default("Active"),
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
});

export const updateDepotSchema = createDepotSchema.partial();

export type CreateDepotInput = z.infer<typeof createDepotSchema>;
export type UpdateDepotInput = z.infer<typeof updateDepotSchema>;
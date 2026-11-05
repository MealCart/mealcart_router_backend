import 'dotenv/config';
import {z} from 'zod';

export const customerTracking = z.object({
 TRACKING_PUBLIC_URL: z.string().url().default('https://tracking.mealcart.com.au/').refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
 }, 'Use an HTTPS tracking page URL without query parameters'),
 TRACKING_LINK_SECRET: z.string().default(''),
 TRACKING_LINK_VALID_DAYS: z.coerce.number().int().min(1).max(7).default(2),
}).parse(process.env);

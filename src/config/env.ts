import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(3001),

  GOOGLE_MAPS_API_KEY: z
    .string()
    .min(1, "GOOGLE_MAPS_API_KEY is required"),

  // Database
  DB_HOST: z.string().min(1, "DB_HOST is required"),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1, "DB_NAME is required"),
  DB_USER: z.string().min(1, "DB_USER is required"),
  DB_PASSWORD: z.string().min(1, "DB_PASSWORD is required"),

  DB_SSL: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),

  // Allowed frontend origins, separated by commas
  CORS_ORIGINS: z.string().default(""),

  // Legacy configuration; does not replace user authentication
  API_TOKEN: z.string().default(""),

  // Authentication cookies
  AUTH_COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  AUTH_COOKIE_SAME_SITE: z
    .enum(["lax", "strict", "none"])
    .default("lax"),

  // Routing limits and cache
  ROUTE_RATE_LIMIT_PER_MIN: z
    .coerce.number()
    .int()
    .positive()
    .default(30),

  ROUTE_CACHE_TTL_MS: z
    .coerce.number()
    .int()
    .nonnegative()
    .default(5 * 60 * 1000),

  ROUTE_CACHE_MAX_ENTRIES: z
    .coerce.number()
    .int()
    .positive()
    .default(100),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
}).superRefine((config, ctx) => {
  if (
    config.AUTH_COOKIE_SAME_SITE === "none" &&
    !config.AUTH_COOKIE_SECURE
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AUTH_COOKIE_SECURE"],
      message:
        "AUTH_COOKIE_SECURE must be true when AUTH_COOKIE_SAME_SITE is none",
    });
  }

  if (
    config.NODE_ENV === "production" &&
    !config.AUTH_COOKIE_SECURE
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AUTH_COOKIE_SECURE"],
      message: "AUTH_COOKIE_SECURE must be true in production",
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error("❌ Invalid environment variables:");

    for (const issue of parsed.error.issues) {
      console.error(`   ${issue.path.join(".")}: ${issue.message}`);
    }

    console.error(
      "\n→ Check your server/.env file against server/.env.example",
    );

    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const corsEnabled = env.CORS_ORIGINS.trim().length > 0;

export const corsOrigins = corsEnabled
  ? env.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : [];

// Legacy flag only. User session authentication must remain mandatory.
export const authEnabled = env.API_TOKEN.length > 0;

export const isDev = env.NODE_ENV === "development";
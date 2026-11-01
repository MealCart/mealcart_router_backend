import express from "express";
import helmet from "helmet";
import cors from "cors";
import { corsEnabled, corsOrigins } from "./config/env.js";
import { apiRouter } from "./routes/index.js";
import {
  errorMiddleware,
  notFoundMiddleware,
} from "./middleware/error.middleware.js";
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware.js";

export function createApp() {
  const app = express();

  // Trust proxy headers when behind nginx (needed for rate-limiting by real IP)
  app.set("trust proxy", 1);

  // Security headers
  app.use(helmet());

  // CORS — only enabled if CORS_ORIGINS is set
  if (corsEnabled) {
    app.use(
      cors({
        origin: corsOrigins.includes("*") ? true : corsOrigins,
        credentials: true,
      }),
    );
  }

  // Request logging
  app.use(requestLoggerMiddleware);

  // Body parser (10kb limit is plenty for our payloads — max 25 jobs)
  app.use(express.json({ limit: "100kb" }));

  // Health check at root (useful for uptime monitors)
  app.get("/", (_req, res) => {
    res.json({ ok: true, data: { name: "Mealcart API", status: "up" } });
  });

  // All API endpoints under /api
  app.use("/api", apiRouter);

  // 404 + error handlers (must be last)
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
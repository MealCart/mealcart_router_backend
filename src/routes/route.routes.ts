import { Router } from "express";
import { planRouteController } from "../controllers/route.controller.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { planRouteSchema } from "../validators/route.validator.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.middleware.js";
import { asyncHandler } from "../utils/async-handler.js";

export const routeRouter = Router();

// POST /api/routes/plan
routeRouter.post(
  "/routes/plan",
  rateLimitMiddleware,
  validateBody(planRouteSchema),
  asyncHandler(planRouteController),
);
import { Router } from "express";
import {
  createDepotController,
  deleteDepotController,
  getDepotController,
  listDepotsController,
  updateDepotController,
} from "../controllers/depot.controller.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { createDepotSchema, updateDepotSchema } from "../validators/depot.validator.js";
import { asyncHandler } from "../utils/async-handler.js";

export const depotRouter = Router();

depotRouter.get("/depots", asyncHandler(listDepotsController));
depotRouter.get("/depots/:id", asyncHandler(getDepotController));
depotRouter.post(
  "/depots",
  validateBody(createDepotSchema),
  asyncHandler(createDepotController),
);
depotRouter.put(
  "/depots/:id",
  validateBody(updateDepotSchema),
  asyncHandler(updateDepotController),
);
depotRouter.delete("/depots/:id", asyncHandler(deleteDepotController));
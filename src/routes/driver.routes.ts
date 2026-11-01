import { Router } from "express";
import {
  createDriverController,
  deleteDriverController,
  getDriverController,
  listDriversController,
  updateDriverController,
} from "../controllers/driver.controller.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { createDriverSchema, updateDriverSchema } from "../validators/driver.validator.js";
import { asyncHandler } from "../utils/async-handler.js";

export const driverRouter = Router();

driverRouter.get("/drivers", asyncHandler(listDriversController));
driverRouter.get("/drivers/:id", asyncHandler(getDriverController));
driverRouter.post(
  "/drivers",
  validateBody(createDriverSchema),
  asyncHandler(createDriverController),
);
driverRouter.put(
  "/drivers/:id",
  validateBody(updateDriverSchema),
  asyncHandler(updateDriverController),
);
driverRouter.delete("/drivers/:id", asyncHandler(deleteDriverController));
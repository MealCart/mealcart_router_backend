import { Router } from "express";
import { listStopsController } from "../controllers/stops.controller.js";
import { asyncHandler } from "../utils/async-handler.js";

export const stopsRouter = Router();

stopsRouter.get("/stops", asyncHandler(listStopsController));
import { getAssignedRouteDetails } from "../services/assigned-route-details.service.js";
import { updateRoutePlanRoads } from "../models/route-plan.model.js";
import { Router } from "express";
import {
  createRoutePlanController,
  deleteRoutePlanController,
  deleteRoutePlansForDateController,
  getRoutePlanByDriverController,
  getRoutePlanController,
  listRoutePlansController,
  updateStopStatusController,
} from "../controllers/route-plan.controller.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { createRoutePlanSchema, updateRouteRoadsSchema } from "../validators/route-plan.validator.js";
import { asyncHandler } from "../utils/async-handler.js";

export const routePlanRouter = Router();

routePlanRouter.get("/route-plans", asyncHandler(listRoutePlansController));
routePlanRouter.delete("/route-plans", asyncHandler(deleteRoutePlansForDateController));
routePlanRouter.get("/route-plans/by-driver/:driverId", asyncHandler(getRoutePlanByDriverController));
routePlanRouter.get("/route-plans/:id/details", asyncHandler(async(req,res)=>{res.json({ok:true,data:await getAssignedRouteDetails(req.params.id)});}));
routePlanRouter.get("/route-plans/:id", asyncHandler(getRoutePlanController));
routePlanRouter.post(
  "/route-plans",
  validateBody(createRoutePlanSchema),
  asyncHandler(createRoutePlanController),
);
routePlanRouter.delete("/route-plans/:id", asyncHandler(deleteRoutePlanController));
routePlanRouter.patch("/route-plans/:id/stops/:seq", asyncHandler(updateStopStatusController));
routePlanRouter.put("/route-plans/:id/roads",validateBody(updateRouteRoadsSchema),asyncHandler(async(req,res)=>{
 res.json({ok:true,data:await updateRoutePlanRoads(req.params.id,req.body)});
}));

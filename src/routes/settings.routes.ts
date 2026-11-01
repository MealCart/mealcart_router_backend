import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { routeSettingsSchema } from "../validators/settings.validator.js";
import { getRouteSettings, saveRouteSettings } from "../services/settings.service.js";
// Mount after admin/staff authMiddleware and the trusted-origin check.
export const settingsRouter = Router();
settingsRouter.get("/settings/route-planning",asyncHandler(async (_req,res) => {
  res.json({ok:true,data:await getRouteSettings()});
}));
settingsRouter.put("/settings/route-planning",validateBody(routeSettingsSchema),asyncHandler(async (req,res) => {
  res.json({ok:true,data:await saveRouteSettings(req.body,res.locals.user.id)});
}));

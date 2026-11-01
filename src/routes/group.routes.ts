import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../utils/async-handler.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { ApiError } from "../types/api.types.js";
import { createGroupSchema, updateGroupSchema, templateSchema } from "../validators/group.validator.js";
import * as service from "../services/group.service.js";
// Mounted AFTER admin/staff authentication in routes/index.ts.
export const groupRouter = Router();
groupRouter.get("/groups/customers",asyncHandler(async (_req,res) => { res.json({ok:true,data:await service.listGroupCustomers()}); }));
groupRouter.get("/groups",asyncHandler(async (_req,res) => { res.json({ok:true,data:await service.listGroups()}); }));
groupRouter.get("/groups/:id",asyncHandler(async (req,res) => { res.json({ok:true,data:await service.getGroup(req.params.id)}); }));
groupRouter.post("/groups",validateBody(createGroupSchema),asyncHandler(async (req,res) => { res.status(201).json({ok:true,data:await service.saveGroup(req.body)}); }));
groupRouter.put("/groups/:id",validateBody(updateGroupSchema),asyncHandler(async (req,res) => { res.json({ok:true,data:await service.saveGroup(req.body,req.params.id,req.body.version)}); }));
groupRouter.delete("/groups/:id",asyncHandler(async (req,res) => {
 const parsed=z.coerce.number().int().positive().safeParse(req.query.version);
 if(!parsed.success) throw new ApiError(400,"VERSION_REQUIRED","A valid group version is required.");
 await service.deleteGroup(req.params.id,parsed.data);res.status(204).send();
}));
groupRouter.get("/message-templates",asyncHandler(async (_req,res) => { res.json({ok:true,data:await service.listTemplates()}); }));
groupRouter.post("/message-templates",validateBody(templateSchema),asyncHandler(async (req,res) => { res.status(201).json({ok:true,data:await service.saveTemplate(req.body)}); }));
groupRouter.put("/message-templates/:id",validateBody(templateSchema),asyncHandler(async (req,res) => { res.json({ok:true,data:await service.saveTemplate(req.body,req.params.id)}); }));
groupRouter.delete("/message-templates/:id",asyncHandler(async (req,res) => { await service.deleteTemplate(req.params.id);res.status(204).send(); }));

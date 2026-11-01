import type { Request, Response } from "express";
import * as service from "../services/depot.service.js";
import type { CreateDepotInput, UpdateDepotInput } from "../validators/depot.validator.js";

export async function listDepotsController(_req: Request, res: Response) {
  const depots = await service.listDepots();
  res.json({ ok: true, data: depots });
}

export async function getDepotController(req: Request, res: Response) {
  const depot = await service.getDepot(req.params.id);
  res.json({ ok: true, data: depot });
}

export async function createDepotController(req: Request, res: Response) {
  const input = req.body as CreateDepotInput;
  const depot = await service.createDepot(input);
  res.status(201).json({ ok: true, data: depot });
}

export async function updateDepotController(req: Request, res: Response) {
  const input = req.body as UpdateDepotInput;
  const depot = await service.updateDepot(req.params.id, input);
  res.json({ ok: true, data: depot });
}

export async function deleteDepotController(req: Request, res: Response) {
  await service.deleteDepot(req.params.id);
  res.status(204).send();
}
import type { Request, Response } from "express";
import * as service from "../services/driver.service.js";
import type { CreateDriverInput, UpdateDriverInput } from "../validators/driver.validator.js";

export async function listDriversController(_req: Request, res: Response) {
  const drivers = await service.listDrivers();
  res.json({ ok: true, data: drivers });
}

export async function getDriverController(req: Request, res: Response) {
  const driver = await service.getDriver(req.params.id);
  res.json({ ok: true, data: driver });
}

export async function createDriverController(req: Request, res: Response) {
  const input = req.body as CreateDriverInput;
  const driver = await service.createDriver(input);
  res.status(201).json({ ok: true, data: driver });
}

export async function updateDriverController(req: Request, res: Response) {
  const input = req.body as UpdateDriverInput;
  const driver = await service.updateDriver(req.params.id, input);
  res.json({ ok: true, data: driver });
}

export async function deleteDriverController(req: Request, res: Response) {
  await service.deleteDriver(req.params.id);
  res.status(204).send();
}
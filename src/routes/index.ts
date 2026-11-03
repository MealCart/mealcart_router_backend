import {adminMessagingRouter} from "./delivery-messaging.routes.js";
import {adminLocationRouter} from "./driver-location.routes.js";
import {adminProofRouter} from "./delivery-proof.routes.js";
import { driverMobileRouter } from "./driver-mobile.routes.js";
import { Router } from "express";
import { healthRouter } from "./health.routes.js";
import { routeRouter } from "./route.routes.js";
import { depotRouter } from "./depot.routes.js";
import { driverRouter } from "./driver.routes.js";
import { routePlanRouter } from "./route-plan.routes.js";
import { stopsRouter } from "./stops.routes.js";
import { authRouter } from "./auth.routes.js";
import { requireTrustedOrigin } from "../middleware/auth.middleware.js";
import { authMiddleware } from "../middleware/auth.middleware.js";

import { groupRouter } from "./group.routes.js";

import { settingsRouter } from "./settings.routes.js";

import { keyRouter } from "./key.routes.js";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use("/driver-mobile",driverMobileRouter);
apiRouter.use(requireTrustedOrigin);
apiRouter.use(authRouter);
apiRouter.use(authMiddleware);

apiRouter.use(routeRouter);
apiRouter.use(depotRouter);
apiRouter.use(driverRouter);
apiRouter.use(routePlanRouter);
apiRouter.use(stopsRouter);
apiRouter.use(groupRouter);
apiRouter.use(settingsRouter);
apiRouter.use(keyRouter);

apiRouter.use(adminProofRouter);

apiRouter.use(adminLocationRouter);

apiRouter.use(adminMessagingRouter);

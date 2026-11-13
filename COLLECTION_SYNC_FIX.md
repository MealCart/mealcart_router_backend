Collection proof sync fix — PostgreSQL 42P08

Cause: collection-proof.service.ts reused parameter $8 as the notification driver_id (varchar) and drivers.public_id comparison (text). PostgreSQL rejected the INSERT with inconsistent inferred types. The transaction rolled back, and the app retained local evidence.

Fix: explicitly cast $8::text at both uses in this notification INSERT. No database schema or mobile source change is needed.

Deployment:
1. Replace the route planner / driver backend source with this archive and deploy using the existing npm ci / npm run build / npm start configuration.
2. Wait for successful deployment.
3. In the existing installed app, tap Retry saved delivery sync (or Sync now). Saved proof reuses the original receipt ID.
4. Verify the collection and route stop are completed and photos/signature are visible in office route details.
Do not uninstall or clear phone storage. No need to repeat the collection photos or signature. The existing migration tables are sufficient.

Validation: production TypeScript build and all 11 focused collection proof tests passed. An isolated embedded PostgreSQL regression reproduced code 42P08 with the old query and successfully inserted the driver ID and name with the fixed query. No live database was modified.

Optional SQL regression reproduction: install @electric-sql/pglite temporarily (npm install --no-save --package-lock=false @electric-sql/pglite), then node scripts/regression-notification-types.cjs. It uses a private in-memory database only.

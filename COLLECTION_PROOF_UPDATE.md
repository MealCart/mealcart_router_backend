Collection photos and driver signature — 13 November 2026

Behaviour
- Collection Complete order opens collection proof: 1–6 photos and a drawn driver signature. No parcel scanning.
- Deliveries still require every parcel label, 1–6 photos and a driver signature.
- Both types save proof locally offline and retain it until the server confirms the matching receipt.
- Collection completion updates collections.status, route stop evidence and the existing collection completion notification event.
- Office route-details endpoint returns collection proof; existing authenticated image access serves it.

Deployment order
1. Before upgrading, have drivers sync pending work using their existing app/backend. Old unsynced collection confirmations contain no proof; this update preserves and blocks those records for office review rather than inventing evidence. Do not clear app data containing unsynced work.
2. Run migrations/20261113_collection_proof.sql against the shared PostgreSQL database using pgAdmin. This adds collection receipt and media tables; it does not alter existing bookings.
3. Deploy the complete route planner and driver backend. Use existing environment settings and persistent proof disk (UPLOAD_DIR). Build: npm ci && npm run build. Start: npm start. Keep the existing notification worker deployment.
4. Rebuild/install the supplied mealcart-driver source with the existing EAS configuration. No new native packages are required. Keep the driver API URL pointing at the updated backend.
5. Download today's routes again after upgrading. The new download includes collection proof state. Older downloads containing collections must be refreshed; pending work is retained.

Device acceptance checks
- Mixed route: delivery still requires all labels before proof; collection immediately permits photos/signature with no scan step.
- Cannot submit without a photo and a complete drawn signature.
- Airplane mode: complete collection, restart app and reopen saved proof. Reconnect, sync and confirm completion/photos/signature on office route details.
- Retry submission after a connection interruption: same receipt, no duplicate completion.
- Confirm collections.status becomes completed; confirm delivery behaviour is unchanged.
- Historical collections completed before this update remain historical, without invented proof.

Scope
Customer portal and warehouse app source require no changes for this flow. No collection POD PDF export was added. The planner's existing evidence panel may still use delivery wording and show zero parcel barcodes for collections; collection evidence is returned by its existing backend endpoint.

Validation
Driver TypeScript check, backend TypeScript check and production build passed.
11 focused automated tests passed (mocked database/media; no live database used).
Camera, signature touch input, SQL deployment and real-device sync require deployment/device checks.

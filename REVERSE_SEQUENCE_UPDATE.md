Reverse sequence — Mealcart route planner

Deploy BOTH archives: router_backend_reverse_sequence.zip and route_planner_reverse_sequence.zip.

1. In pgAdmin run migrations/20261114_reverse_sequence.sql from the backend archive once. It is safe to rerun and only creates the existing route-change audit table if missing; existing routes and events are untouched.
2. Deploy the complete router backend source with existing environment settings. npm ci; npm run build; npm start. Keep all working tracking/POD/media secrets, PORTAL_API_BASE_URL, upload disk and notification-worker settings.
3. Deploy the complete route planner frontend: npm ci; npm run build; publish dist as before.
4. No customer portal changes and no driver app rebuild are required.

How to use
- Select the date and driver and calculate or load a route with at least two stops.
- Under Plan the journey click Reverse sequence.
- The last delivery/collection becomes stop 1, and the former first stop becomes the last. The depot remains the start/return, outside delivery/collection numbering.
- The map path is traversed in reverse. Its shape, driver, depot, stops, route date, total distance and total driving-time estimate stay the same. Existing via points are remapped to their reversed legs.
- The action does not call Google or run optimization. Arrival estimates are rebuilt using the existing travel legs.
- For a new unsaved route, click Assign Plan to save.
- For a saved route, click Save route changes, review Save reversed sequence and confirm. Before saving, Undo reverse sequence restores the saved order.
- Have the driver sync saved work BEFORE reversing any saved route. AFTER saving, the driver must update today's full route download. Existing downloaded stop lists do not silently change.
- Saved routes already started or containing recorded driver scans, delivery/collection proof, failure reports or other completed stops cannot be reversed.

Travel-estimate limitation
Reversing the sequence intentionally reuses the existing road path, distance and time estimates. These are not newly calculated reverse-direction travel times; one-way roads, turns and traffic can make fresh directions differ. After saving/assigning the reversed order, use Recalculate Order (not Plan Route optimization) when fresh driving directions are needed, then save the recalculated route. The driver's existing Directions button still opens Google Maps for each destination.

Safety and concurrency
The backend reads saved geometry itself; it does not accept client-supplied reversed geometry. Version checks prevent stale overwrites. An atomic audit event preserves the before/after plan, and a unique request ID prevents a retry from reversing twice. A failed save retains the preview for undo/review. Other route edits must be saved/undone before reversing.

Validation
- 15 reversal tests passed: mixed stops, 100 stops, unchanged totals, no mutation, reverse twice, via bindings, depot/arrival calculations, idempotency, version/driver changes and recorded progress.
- Existing tracking/POD tests passed alongside the reversal tests (28 cases after the 100-stop case).
- Planner frontend production build + TypeScript check and router backend production build passed.
- Isolated embedded PostgreSQL test executed the transaction SQL, replay, second reverse and proof block successfully. It did not connect to your live database.
- Full browser/phone acceptance testing remains after deployment.

Developer tests
Backend: node --test test/reverse-sequence.test.cjs test/tracking-pod.test.cjs test/pod-media.test.cjs
Optional PostgreSQL regression: npm install --no-save --package-lock=false @electric-sql/pglite; node scripts/regression-reverse-sequence.cjs
The frontend/backend helper parity test runs when both projects are checked out with the original route_planer sibling folder name; otherwise only that parity check is skipped.

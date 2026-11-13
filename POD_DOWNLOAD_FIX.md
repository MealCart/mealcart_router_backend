POD PDF download fix — deliveries and collections

Deploy all three supplied projects. No mobile rebuild and no new SQL migration are required. Existing collection completion migrations must remain installed. Both backends must access the shared database as before.

IMPORTANT: Set POD_MEDIA_SECRET to the SAME private random string (at least 32 characters) on BOTH backend services in Render Environment:
- Customer portal and staff app backend
- Route planner and driver app backend
Never put this setting on the frontend or in any VITE_/EXPO_PUBLIC_ variable.
Generate one value locally with Node:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
Copy that generated value to both backend services. Do not use the example test secret found in automated tests.

Deployment order
1. Add POD_MEDIA_SECRET to both backend services. Keep all current database, auth, upload disk and SMTP variables.
2. Deploy route_planner_driver_backend_pod_fixed.zip using npm ci, npm run build, npm start. This includes the previous collection SQL type-conflict fix and a signed internal POD media endpoint. Driver image access remains protected.
3. Deploy customer_portal_backend_pod_fixed.zip using npm ci and npm start. New dependency @pdf-lib/fontkit and bundled licensed fonts are included; preserve assets/fonts. This backend checks customer booking ownership before resolving completion receipts and generating the PDF.
4. Deploy customer_portal_pod_fixed.zip with npm ci and npm run build; publish dist as before. The frontend now passes the selected tab's booking type. Encoded references support # and other URL characters.
5. Open a completed delivery and select Download POD; repeat for a completed collection. Each should download a PDF containing stored completion metadata, all photos and the driver signature.

Media host
Default driver host remains https://mealcart-router-backend.onrender.com. If it changes, set DRIVER_MEDIA_BASE_URL on the customer portal backend. Keep the existing UPLOAD_DIR persistent proof disk on the driver backend. Files lost from that disk cannot be recreated from database URLs; the PDF request reports missing media instead of silently leaving evidence out.

PDF contents
- Proof of Delivery / Proof of Collection heading
- Reference, recipient/collected-from name, company, address, phone/email if recorded
- Scheduled date, completion status, driver-recorded completion time and separate server-confirmed time when different (Australia/Melbourne)
- Driver name/ID, route, stop, completion receipt ID, parcel count when stored, instructions
- A separate page for every stored completion photo and the driver signature
- Page numbers and embedded fonts for stable rendering
Historical completions without photos/signature are explicitly identified. Pending bookings cannot generate PODs. No warehouse scan is treated as delivery or collection evidence.

Security
Customer ownership is enforced on both booking types. Media requests are signed for one file ID and expire quickly. The shared secret is never sent to the browser or included in a media URL. Unsigned requests, altered file IDs, expired signatures and unapproved remote hosts are rejected.

Validation
- Customer backend npm test: 30 passed.
- Driver backend collection/POD authentication tests: 15 passed.
- Driver backend TypeScript production build and customer frontend production build passed.
- Receipt joins tested on isolated embedded PostgreSQL, including offline timestamps.
- Synthetic delivery and collection PDFs generated, text checked, rendered and visually inspected.
No live customer database or Render deployment was modified. Complete a production POD download after deployment to confirm your host secret and proof disk settings.

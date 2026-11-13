Tracking page POD downloads — deployment instructions

What changed
The tracking page shows Download POD (PDF) after a delivery or collection is completed and its source status has synced. The existing private tracking token authorizes exactly one booking. The router revalidates expiration, revocation, recipient binding, owner, scheduled date, reference and record ID for each download. No login is required. The PDF uses the existing working customer-backend generator, with photos, driver signature and recorded completion details.

Deploy these THREE updates in order
1. Customer portal/staff backend: customer_portal_backend_tracking_pod.zip
   Use npm ci / npm start as before. This adds a signed internal PDF-generation endpoint; normal customer portal POD downloads remain authenticated as before.
2. Route planner/driver backend: router_backend_tracking_pod.zip
   Add ONE environment variable on THIS service:
   PORTAL_API_BASE_URL = the HTTPS root URL of your CUSTOMER PORTAL/STAFF BACKEND web service.
   Copy its actual public Render URL. Do not use the frontend URL, tracking website URL or router URL. Do not append /api or an endpoint path.
   Keep your existing matching POD_MEDIA_SECRET on both backend services. It is already working; do not regenerate it.
   Keep all database, tracking, SMTP and upload disk settings. Use npm ci / npm run build / npm start as before.
3. Tracking website: tracking_with_pod.zip
   Replace the existing tracking website files, including app.js, index.html and styles.css. Keep config.js pointed at the updated router backend. Upload the site files at the same root as before. Use a hard refresh if an old JavaScript file is cached.

No new SQL migration, driver app rebuild, customer portal frontend deployment or template change is needed. The updated router retains the prior collection SQL fix and protected image endpoint.

Existing {{tracking_link}} messages still work while their tokens remain valid. Open a completed order's link to see Download POD. Pending, failed and cancelled orders do not show it. A token that expires before the click cannot download a document. If you deliberately want links valid longer, the existing TRACKING_LINK_VALID_DAYS setting controls issuance (1–7 days); changing it does not retroactively extend existing links.

Secret responsibilities
- TRACKING_LINK_SECRET: existing shared value on router API and notification worker; unchanged.
- POD_MEDIA_SECRET: existing matching value on router and customer backend; used privately for server-to-server PDF requests and image retrieval; unchanged.
- PORTAL_API_BASE_URL: new router setting pointing to the CUSTOMER BACKEND root.
Never place secrets in tracking config.js, HTML or frontend/public environment settings.

Browser behaviour
The button generates and downloads the PDF on demand, shows Preparing PDF while working, and permits retries if generation fails. Driver location stays hidden after completion. Token stays in the URL fragment and POST bodies, never in a download query string. There is a limit of five POD requests per IP per minute.

Acceptance checks after deployment
- Completed delivery: download and inspect its own PDF photos/signature/details.
- Completed collection: download and inspect collection PDF.
- Pending, failed, cancelled, invalid and expired links: no POD download.
- Test on a desktop and phone; on phones the browser may open the PDF preview/download UI.
- Confirm existing portal POD buttons and driver collection completion still work.
- On failure, inspect router POD error code and customer backend logs; verify PORTAL_API_BASE_URL is the backend root and POD_MEDIA_SECRET still matches.

Validation performed
Customer backend: 36 tests passed. Router: 13 POD/token authentication tests passed and production TypeScript build passed. Tracking JavaScript: 7 DOM flow tests passed; syntax check passed. Full browser rendering was blocked by workspace restrictions, so verify the deployed page visually. No live messages were sent and no live database/deployment was modified.

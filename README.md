# Mealcart pallet management

This update adds a PostgreSQL pallet ledger, admin page, PDF statements and driver handovers. Pallet confirmations use EMAIL ONLY to BOTH the client and driver. Existing delivery SMS settings and templates are unchanged.

## Install in this order

### 1. Database
Open Mealcart_Pallet_Management_PgAdmin.sql in pgAdmin against the same database as the API and cron. Run the complete script. It is safe to rerun. It creates new pallet tables; it does not clear delivery, route, key or customer records.

### 2. Backend API and notification cron
Merge this ZIP's server/src into your EXISTING backend src. Keep every other backend file, package.json and environment setting. This is an update package, not a standalone backend.
Copy install-pallet-backend.mjs into the backend root (beside package.json). From that backend folder run:

    node install-pallet-backend.mjs
    npm run build

The setup script adds the mobile pallet router before the existing driver router and the admin router after session authentication. It adds pallet email dispatch AFTER the existing notification tick. It preserves the existing route, key, GPS and delivery handlers. It can be rerun without adding duplicate hooks. If its expected anchors are missing, it stops with instructions rather than guessing.

Commit ALL changed/new backend files, including routes/index.ts and workers/delivery-notifications.ts, push and deploy BOTH your API service and your existing notification cron from that commit. No additional cron service is needed.

Keep NOTIFICATIONS_ENABLED=true on the cron and keep the existing working SMTP settings. No new environment variables or npm dependencies are needed. Pallet emails do not call Twilio. Pallet-email processing failures are logged separately and do not prevent the existing delivery tick from completing.

### 3. Admin frontend
Either use the full route_planer_updated.zip supplied with this update, or merge this ZIP's frontend/src into your current frontend src. The updated prototype helper/test is included for consistency; the live pallet page reads only the server ledger.
Keep your existing .env/VITE_API_URL setting. Build as usual:

    npm ci
    npm run build

The full frontend retains the previous route-management update. No other page's business flow was changed by the pallet work.

### 4. Driver app
Merge this ZIP's mobile/src into your existing driver app src. It adds pallet-register.ts and replaces only the pallet placeholder screen.
Copy mobile/install-pallet-mobile.mjs into the DRIVER APP root (beside its package.json) and run there:

    node install-pallet-mobile.mjs

This exposes the existing authenticated request helper to the pallet register. On the current home/auth files it enables the pallet tile, adds a pending-sync count and prevents sign-out while pallet receipts are pending. It preserves keys, deliveries, location sharing, theme and offline route storage.

Use your existing development client with a clean Metro restart, or rebuild the installed Android APK to include the new JavaScript:

    npx eas-cli@latest build --platform android --profile preview

No new native module or location permission is required. No change to the public tracking website is needed.

## How balances work

Each CLIENT ACCOUNT and PALLET TYPE has its own ledger. CHEP, LOSCAM and PLAIN never cancel each other out. Driver identity does not split a client's balance; multiple drivers can collect/issue for the same client.

- Collection from client: + quantity. Positive balance = MEALCART OWES CLIENT.
- Issue to client: - quantity. Negative balance = CLIENT OWES MEALCART.
- Example: collect 5 CHEP, issue 7 CHEP -> balance -2 -> client owes Mealcart 2 CHEP.
- Multiple entries for the same client on the same day are allowed. Each receipt has a unique UUID and timestamps.
- The three summary cards show debts in each direction separately, so one client's debt is not hidden by another client's credit.
- Balances carry forward indefinitely. They do not reset each month.

This is a client handover/obligation ledger, not a pallet-brand hire-account integration or a driver/warehouse stock-location ledger.

## Driver workflow and offline work

1. Open Pallets and refresh while online to download active client names and server balances.
2. Search/select a client; choose Collect or Issue, type, quantity and optional note.
3. Confirm the physical handover. A receipt is saved on the phone BEFORE submission.
4. With internet it submits immediately. Otherwise a visible pending-sync banner and the home tile count remind the driver to sync from Pallets.
5. Press Sync saved pallet receipts when online. Client/driver emails and office balances update only after server acceptance.

Pending pallets have a separate SQLite prefix scoped to API URL + driver ID. Existing route scans/proof queues are unchanged. A lost response retries the same receipt UUID; it cannot count the movement or enqueue email confirmations twice. Changing driver accounts cannot submit the other account's pending receipts.

Cached balances are labelled as saved copies. Pending receipts are shown separately rather than presented as a confirmed server balance. Keep app data until synced. A rejected receipt stays saved with its error for office review. If an account was deactivated, resolve it with the office before retrying; valid other receipts can still sync.

Drivers can view their own recent receipts. They cannot reverse, alter or delete posted entries. Driver handovers are independent of route start, so pallets can be recorded without a delivery job at that client.

## Admin corrections

The Pallet Management page shows balances, handover history and email confirmations. An administrator can click Reverse on an original collection or issue, provide a required reason and confirm. Staff can read/report; only admins can reverse or retry failed emails.

A reversal inserts the exact opposite quantity for the same client/type/driver. It never removes or edits the original receipt. It records administrator name, reason and server timestamp, and emails the client and original driver. A receipt can only be reversed once; a reversal cannot itself be reversed. To correct a quantity, reverse the mistaken entry, then have the driver record the correct handover with a reference note.

The database rejects direct UPDATE or DELETE of pallet movement rows. Current balances derive from signed ledger entries; original and reversal history remain reportable.

## Client PDF statement

Select a client, optionally choose from/to dates, then download Client PDF statement. It includes all three types, opening balance before the period, closing balance at period end, chronological movements, corrections, receipt references, driver and recording-actor names, and notes. Times and date boundaries use Australia/Melbourne, including daylight saving.

The admin balance table always shows current ALL-TIME balances. Date filters apply to movement history and the PDF. The PDF deliberately includes all three types even if the on-screen type filter is narrower.

Reports use a consistent database snapshot and are generated on demand, not stored on the server disk. No PDF npm/native dependency is needed. Standard PDF Helvetica/WinAnsi fonts support Latin-script statements; characters outside that font encoding are represented by a question mark. Choose a shorter period if a report exceeds 10,000 entries; entries are never silently truncated.

## Email confirmations

- Client address: users.email for the selected customer account.
- Driver address: drivers.email for the driver who recorded the handover.
- Both collection and issue receipts, plus admin reversals, queue a separate email for each recipient.
- Emails contain client, driver, type, quantity, time, receipt reference, note and the balance after posting. They explain which side owes pallets and instruct recipients to contact the administrator about mistakes.
- Pallet confirmations are direct receipts; selecting a group template is not required.
- Emails are queued in the SAME transaction as the ledger entry. SMTP failures cannot undo or lose a posted physical handover.
- Email confirmations shows queued, sending, provider accepted, failed, blocked and unknown results. Provider accepted is not proof of inbox delivery.
- Missing/invalid addresses are blocked visibly. Update the account and click Retry email. Accepted or uncertain sends cannot be blindly resent, preventing duplicate confirmations.
- The worker claims messages atomically, sends email only and uses a bounded batch. A worker interruption is marked unknown for office review rather than automatically sending again.

## Verification performed

- 29 automated checks passed: PostgreSQL-compatible ledger/API checks, rendered admin UI interactions and driver offline-queue logic.
- Tests cover negative balances, separate clients/types, repeated handovers, idempotent retries, immutable history, admin-only reversals, address failures/retries, email-only delivery, uncertain-send handling, report opening/closing balances, PDF attachment access and mobile account isolation.
- Strict backend TypeScript check passed against the existing Zod 3 interface. Frontend TypeScript check and production Vite build passed.
- Both setup scripts were applied twice to representative current project files to verify rerun behavior. Changed mobile files were transpiled successfully.
- An 8-page test statement was rendered and inspected for pagination and receipt retention.
- No live database, real recipient, SMTP server, SMS provider, Google API or production deployment was used by these tests.
- An EAS build and physical Android/iOS interaction were not run here. Test one collection, issue, reversal, offline sync and email receipt on your device after installing the updated APK.

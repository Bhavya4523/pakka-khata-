# Pakka Khata — Local-first digital khata for small Indian shops

Pakka Khata is a private digital khata book for small Indian shops. It is designed to read a photo of a handwritten ledger page into a reviewable set of rows, then draft a polite payment reminder in the customer's language.

## Current status

Phase 1 provides the stateless FastAPI service, image validation and in-memory multipart processing, Ollama/OpenAI-compatible provider adapter for open-weight models, extraction validation and retry/repair, reminder drafting, demo mode, security headers, Docker/Render deployment foundation, and API tests. Phase 2 adds the multilingual React/Vite ledger shell, Dexie/IndexedDB browser storage, shop setup, summary dashboard, sample ledger, App Lock, encrypted backup/restore, CSV export, deletion, and PWA offline app shell. Phase 3 connects photo scanning and review to the API, then adds editable ledger rows, customer management, manual entries and payments, and WhatsApp-ready reminder drafts. Phase 4 adds labelled-image evaluation tooling, accessibility/security release checklists, and final verification guidance. Model accuracy and public-deployment readiness are not claimed until the documented checks have actually been run.

## Data ownership and privacy

- The backend has no database, session store, user accounts, cookies, or ledger storage.
- The backend reads multipart request bodies into bounded memory; it does not save uploaded photos to disk.
- The app logs request method, path, status and elapsed time only. It does not log request bodies, image contents or customer fields.
- Demo mode returns a bundled sample extraction and marks it `demo: true`; it never claims that the sample was read from the photo.
- In hosted model mode, an image is sent in memory to the configured model server that you control. It is not persisted by this application. Choose the server and its own logging policy deliberately.
- Shop, customer, and entry records are stored in browser-owned Dexie/IndexedDB. Encrypted `.pkb` backup/restore and plaintext CSV export are implemented in Phase 2. Different browser profiles for the same origin are isolated by the browser. People sharing the same browser profile on one device share that browser's khata; App Lock is intended to deter casual snooping, not to replace device security.

## Run tests

Use Python 3.11 for deployment compatibility. From the project root:

```bash
python -m venv .venv
# Windows PowerShell: .venv\\Scripts\\Activate.ps1
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements.txt
pytest
```

## Run the demo API locally

```bash
# Windows PowerShell
$env:DEMO_MODE = "true"
$env:APP_ENV = "development"
uvicorn backend.main:app --reload --port 8000
```

Open <http://localhost:8000>. Check <http://localhost:8000/api/health>.

A demo scan must upload a real JPEG/PNG/WebP signature. Its result is a fixed sample and has `demo: true` plus a warning that it was not read from the uploaded photo.

## Local model (Ollama)

Install Ollama, then pull the default open-weight model:

```bash
ollama pull gemma3:4b
```

Set `DEMO_MODE=false` and use `LLM_PROVIDER=ollama`, `BASE_URL=http://localhost:11434`, and `MODEL_NAME=gemma3:4b`. For Docker Compose, first start the services with `docker compose up --build`, then in another terminal run:

```bash
docker compose exec ollama ollama pull gemma3:4b
```

## Hosted demo on Render

The included `render.yaml` sets `DEMO_MODE=true` so the service works without a GPU or an external inference server. This demo is clearly labelled. For real scans, configure an open-weight vision model on a GPU server you control, then set:

- `LLM_PROVIDER=openai_compat`
- `BASE_URL=https://YOUR-MODEL-SERVER/v1`
- `MODEL_NAME=YOUR_OPEN_WEIGHT_VISION_MODEL`
- `API_KEY` as a Render secret if your server requires it
- `DEMO_MODE=false`

The server should expose an OpenAI-compatible `/chat/completions` endpoint with image input. Do not use a closed third-party AI API for sensitive customer ledgers.

## Ownership guarantees

Phase 1 enforces server statelessness structurally: there are no database dependencies or user-record routes, the backend does not set cookies, the request body is capped and parsed in memory instead of using `UploadFile` disk spooling, and uploaded image bytes are not written by application code. The test `test_no_disk_writes_or_database_paths_during_demo_scan` blocks file writes and SQLite connection creation during the scan route. `test_two_simulated_clients_get_no_shared_ledger_data` confirms that client identity headers do not select server-side records and no ledger endpoint exists.

The frontend ownership test models two isolated IndexedDB stores. Browser-enforced storage isolation means normal Chrome and Incognito profiles keep separate databases for the same origin. Two people sharing the same browser profile on the same device will share that local data; use the optional App Lock to keep casual snoopers out. The UI does not send the local customer ledger to the backend.

## Current limitations

- Handwriting accuracy depends on the chosen vision model. Review rows before saving; the application flags confidence below 0.7, but model confidence may not be calibrated.
- `DEMO_MODE=true` is a sample response, not OCR or model inference.
- The per-IP rate limiter is in-memory per process. On multi-worker deployments, limits are per worker, not globally coordinated.
- No cross-device sync exists. Use the encrypted backup/restore feature to move a khata between devices.

## Phase 2: browser-local khata foundation

The React application now stores shop settings, customers, and ledger entries in Dexie/IndexedDB named `pakka-khata-local`. The Python service remains stateless: it does not receive, store, or sync the local customer ledger. Browser data is scoped to the same browser profile and origin. A separate browser profile (such as Chrome Incognito) gets separate IndexedDB storage, while people using the *same browser profile* on a shared device can see the same local data. Use App Lock for casual snooping and the encrypted backup passphrase for backup protection.

### Local storage guarantees

- Shop, customer, and ledger records are written only to browser IndexedDB. The UI does not send them to the API.
- `navigator.storage.persist()` is requested during first setup and can be requested again in Settings. The browser may deny the request; backups remain important.
- PINs are not stored in plaintext. The app stores a PBKDF2-SHA-256 hash and random salt in IndexedDB. The PIN is a casual-snooping barrier, **not encryption of ledger contents**.
- `.pkb` backups use Web Crypto: PBKDF2-SHA-256 with 310,000 iterations, random salt, AES-256-GCM, and a random 12-byte IV. The backup excludes PIN hash/salt. If the passphrase is lost, this application cannot recover the backup.
- CSV export is plaintext and readable by anyone who opens it. Protect the file appropriately.
- The app lock activates on app open and after five minutes in the background. Five wrong attempts trigger a delay, which increases after further groups of failures.
- “Delete all data on this device” requires typing `DELETE` and removes the shop, customers, entries, and PIN from this browser's IndexedDB.
- The bundled sample ledger is marked as sample data and can be removed from Home.

### Ownership guarantees (tests/README)

The API has no ledger database, account/session storage, or route that writes customer data to disk. Image uploads are validated and passed in memory to the configured model provider; they are not written to disk by application code. Request logs include only method, path, status, and latency. In local Ollama mode, the image stays on the local machine/network; a hosted inference provider receives the image temporarily, so hosted mode does not have the same network-local privacy property.

The frontend ownership test simulates two isolated IndexedDB databases to verify their data does not cross between stores. Actual browser separation depends on origin and browser profile: normal Chrome and Incognito are isolated; two people sharing the same browser profile share the same khata, which is why App Lock exists. There is no cross-device sync. Use encrypted backup/restore to move data between devices.

### Verify Phase 2

From `frontend/` run:

```powershell
npm install
npm test
npm run build
```

From the project root run:

```powershell
python -m pytest
```

Then run the browser ownership check: open the same local/deployed URL in a normal browser window, click **Try with a sample page**, and verify sample data appears. Open the same URL in Incognito and confirm the dashboard is empty. The data should remain visible in the normal window when you return. Capture both screens for the project write-up.

### Scope note

Phase 2 implements setup, browser-local data, dashboard, settings, storage persistence request, PIN lock, encrypted backup/restore, CSV export, data deletion, translations, and the installable/offline app shell. Phase 3 adds the scan/review flow, fuzzy customer suggestions requiring explicit confirmation, customer detail/edit screens, manual credit/payment entries, and reminder drafting. Ledger rows are committed to IndexedDB in one transaction after review. Scans are preprocessed in the browser to a maximum 1600 px long edge and JPEG quality 0.85; the photo is held only in component memory and is discarded when the scan is cancelled or saved.


## Phase 3: scanning, review, customers and reminders

The Scan screen accepts camera/gallery photos, uses browser decoding to respect image orientation, resizes the photo to a maximum 1600 px long edge, encodes JPEG at quality 0.85, and posts it to `POST /api/scan`. It shows an elapsed-time progress state, supports cancellation, and displays a calm error when the model is unavailable or the request fails. The selected photo stays in component memory; the backend accepts image bytes in memory and does not save them to disk.

The Review screen shows the photo and editable row fields (customer name, date, items, amount, credit/payment type), visible text for confidence under 0.7, provider warnings, and the model's raw transcription. Missing rows can be added and rows deleted. Customer fuzzy matches are suggestions only; a person must explicitly choose an existing customer. Saving validates required fields and writes customer/entry changes in one Dexie transaction. Sample/demo API results are explicitly labelled and cannot be saved as real ledger rows.

The Customers screen supports search over names/phones/notes and sorting by balance or most recent activity. Customer detail includes editable name/phone/notes, a date-ordered ledger with running balance, manual credit entries, payment recording with full/half/custom amount shortcuts, and reminder drafting in English, Hindi, Marathi or Hinglish. Reminder text is editable before copying or opening `wa.me`; the application does not use the WhatsApp API. If the reminder endpoint is unavailable or the browser is offline, a local template is offered and labelled for review.

### Verify Phase 3

From `frontend/` run:

```powershell
npm install
npm test
npm run build
```

From the project root run:

```powershell
python -m pytest
docker compose up -d --build --force-recreate
docker compose ps
Invoke-RestMethod http://localhost:8000/api/health | ConvertTo-Json
```

Then test a real photo via the Scan screen, correct one field in Review and save; verify that the entry is visible under that customer, record a payment and check the balance; draft/edit/copy a reminder. Confirm photo cancellation returns to scan selection and the image is not visible after save.

## Phase 4: evaluation and release readiness

Phase 4 adds a labelled-photo evaluation harness at `tools/evaluate_scans.py`. It measures row and field agreement (date, item description, amount, credit/payment type, and customer name when labelled) plus per-request latency median/p50/p90/min/max. It excludes demo responses from accuracy scoring and writes aggregate metrics only, without image paths, transcriptions, customer names, or extracted values. See `docs/PHASE4_EVALUATION.md` for manifest format and procedure.

No model accuracy number is claimed in this repository until the harness has been run against independently labelled images. A single photo is not a representative benchmark. The docs also include manual accessibility and security/deployment release checklists; checklist items are not considered passed until they have actually been tested and recorded.

For release verification on Windows, run `npm test`, `npm run build`, `python -m pytest`, `docker compose config`, `docker compose up -d --build --force-recreate`, and the local browser/Incognito ownership test. Review `npm audit` and Python dependency advisories before publishing; do not blindly apply force upgrades.

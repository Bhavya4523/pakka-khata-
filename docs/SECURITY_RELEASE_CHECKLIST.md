# Security and deployment release checklist

Mark each item complete only after execution and retain the result with the release notes.

## Backend and image handling

- [ ] `DEMO_MODE=false` and real local Ollama inference confirmed for model tests; demo output is never reported as model accuracy.
- [ ] Upload rejects unsupported signatures, mismatched content type, empty input and payloads exceeding configured maximum.
- [ ] Request bytes are bounded and handled in memory; no uploaded image or ledger text is written to a backend file or DB.
- [ ] Logs contain only method, path, status and latency; no request bodies, prompt contents, image bytes or customer fields.
- [ ] API responses include `Cache-Control: no-store`; expected security headers are present.
- [ ] Rate limiting is verified, with the documented caveat that in-memory limits are per process/worker.
- [ ] Production `APP_ENV=production` disables docs/OpenAPI; local docs use the development-only CSP allowance.
- [ ] Provider URL/API key are set via runtime environment/secrets. Never store credentials in repository, manifest, or image layers.

## Docker and hosting

- [ ] `docker compose config` succeeds and containers are healthy.
- [ ] Ollama port is not published to the host; the app reaches `http://ollama:11434` using the Compose network.
- [ ] Named Ollama volume holds model weights only, not ledger records or uploaded photos.
- [ ] HTTPS is enabled for any public deployment.
- [ ] Hosted `DEMO_MODE=true` is labelled sample mode; real image inference only enabled for a model endpoint whose owner and data policy are understood.
- [ ] `npm audit` and Python package advisories reviewed; upgrades are reviewed instead of blindly using `npm audit fix --force`.

## Browser-owned data

- [ ] Normal browser and Incognito use the exact same origin for the ownership test; one starts empty and cannot read the other's records.
- [ ] Shop, customers and entries are written only to Dexie/IndexedDB; no ledger endpoint/server database exists.
- [ ] `navigator.storage.persist()` is requested and Settings reflects the browser's returned yes/no status; document persistence is not guaranteed.
- [ ] Encrypted `.pkb` backup uses PBKDF2-SHA-256 (310,000 iterations), random salt, AES-GCM and random IV; PIN hash/salt are excluded.
- [ ] Correct passphrase restores successfully; wrong passphrase fails calmly; schema validation rejects invalid contents; Replace and Merge are tested for stable-ID de-duplication.
- [ ] CSV export is clearly labelled plaintext; users are told that anyone opening it can read it.
- [ ] App Lock stores PIN hash+salt, not plaintext PIN; it is documented as a casual-snooping barrier, not database encryption.
- [ ] Typed `DELETE` removes shop, customers, entries and PIN from the current origin/profile.
- [ ] Cancelled/completed scans release preview object URLs and do not save photo blobs to IndexedDB.

## Accuracy and reminder safety

- [ ] Use `tools/evaluate_scans.py` with independent labelled images and `DEMO_MODE=false`.
- [ ] Inspect false-positive rows (subtotals/net balances), wrong customer name, wrong sign, duplicate rows and missed dates; a correct net total alone is insufficient.
- [ ] Confidence is treated as model-reported and may not be calibrated; every row is reviewed before save.
- [ ] Reminder copy is checked not to invent a due date/deadline or penalties; user must edit/review and manually send via WhatsApp.

## Section 2 Data Ownership — mandatory final re-read

Re-read Section 2 of the project specification and confirm nothing in the final code or configuration violates it. Specifically check that the server has no database/accounts/sessions/cookies/shared storage for ledger data, only request metadata is logged, images/content are not stored/logged/cached by application code, browser IndexedDB is the only ledger record store, and all backup/lock/deletion behavior matches documentation.

Caveats that must remain explicit: browser isolation is per origin/profile rather than login identity; people sharing one profile share the local khata; App Lock does not encrypt IndexedDB; browser persistence can be denied; local Ollama inference stays on the local machine/network, while a hosted model server receives image input transiently.

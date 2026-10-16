# Ownership guarantees

- The FastAPI backend has no ledger database or API write route for shop/customer/entry records.
- Image bytes are accepted and validated in memory, then passed to the configured provider; app code does not write them to disk. Logs include HTTP method, path, status code, and latency only.
- The frontend writes shop, customer, and entry data to Dexie/IndexedDB on-device. It does not upload the local ledger to the API.
- The Vitest ownership test creates two independent IndexedDB stores to model isolated browser profiles and verifies records are not visible across them. Browser storage is naturally scoped by origin and browser profile: normal Chrome vs Incognito are separate, but two people sharing the same browser profile on one device share data. The PIN lock is intended to deter casual snooping; it does not encrypt IndexedDB contents.
- Backups are encrypted locally with Web Crypto (PBKDF2-SHA-256, 310,000 iterations, random salt, AES-256-GCM, random IV). PIN hashes are not included in backups. CSV is plaintext and must be handled carefully.
- Local Ollama mode sends images to the local inference process. When `LLM_PROVIDER=openai_compat` points to a hosted server, that configured model server temporarily receives the image. The app does not store images after the request.

The isolated-database test proves store-level separation, not account authentication or protection between people sharing the same OS/browser profile. No login or cross-device sync exists.


## Phase 3 client flow guarantees

- The selected page is preprocessed and held in component state only. It is not added to Dexie, sent to browser storage, or retained by a backend file path. A scan request sends only the resized JPEG bytes plus a language hint; the server sends those bytes to the configured vision provider in memory.
- Review fields remain in React component state until the user confirms saving. Low-confidence rows include a visible text label and can be corrected, removed, or augmented before a single IndexedDB transaction commits the rows.
- Fuzzy customer matches are suggestions only; the operator must click to choose a suggested existing customer. Normalised names are used to prevent duplicating the same newly-entered name within a single reviewed scan, but existing customers are never silently merged.
- Reminder drafting sends only shop/customer name, outstanding amount, chosen language/tone, and optional last-entry date to `/api/reminder`. No ledger is written to the backend. WhatsApp hand-off is an ordinary `wa.me` link with prefilled text; no WhatsApp API is used. The local fallback is a template and must be reviewed before sending.
- `customer-matching.test.ts` covers Unicode normalization and typo suggestions. The ownership caveats above still apply: IndexedDB isolation is by origin and browser profile, not login identity; people sharing a browser profile share the same data.


## Phase 4 evaluation and release checks

`tools/evaluate_scans.py` runs the configured scan endpoint against a manually labelled manifest. It reports field agreement and latency statistics, excludes `demo: true` samples from accuracy scoring, and writes aggregate results only. It requires independently checked ground truth; do not commit real customer photos or names. See `docs/PHASE4_EVALUATION.md`.

The backend unit tests cover prompt constraints preventing the latest ledger-entry date from being described as a payment deadline. They cannot guarantee the generated model message will never hallucinate; humans must review reminder text before using the WhatsApp hand-off.

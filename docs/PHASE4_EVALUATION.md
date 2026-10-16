# Phase 4 — Accuracy, latency, and release evaluation

Phase 4 adds a reproducible evaluation harness. It does **not** claim an accuracy percentage until it is run against manually labelled images. Never use the canned `DEMO_MODE=true` response as an OCR/model benchmark.

## 1. Prepare a private ground-truth set

Create a local folder outside Git (for example `private-eval/`) containing consented or synthetic ledger photos and a `manifest.json`. Do not commit private ledger photos or customer information. A manifest skeleton is supplied at `tools/evaluation-manifest.example.json`.

For each image, independently transcribe the visible transaction rows from the source page in the same top-to-bottom order. Include only fields that can be verified from the image. Use ISO dates (`YYYY-MM-DD`) and `type: "credit"` for amounts in the Udhaar/Due column or `type: "payment"` for amounts in the Jama/Paid column. Do not include subtotal, total or net balance summary lines as transactions.

Example row:

```json
{"date":"2026-10-10","items":"Old Balance","amount":2150,"type":"credit","customer_name":"Test Customer"}
```

Do not copy a model's prediction into ground truth without checking it against the source photo. The tool expects rows in source order. Fields omitted from a ground-truth row are not scored.

## 2. Run the benchmark

Use `DEMO_MODE=false`, and use the local Ollama provider for privacy-sensitive material. Keep the evaluation set on the local machine.

Windows PowerShell, from the project root:

```powershell
python tools/evaluate_scans.py --manifest private-eval/manifest.json --base-url http://localhost:8000 --runs 1 --output private-eval/report.json
```

Repeat with `--runs 3` only if the additional calls are acceptable; each run invokes the model again and may take several minutes. The tool reports exact field accuracy for the labelled fields, row count mismatches, extra/missing rows, and request latency median/p50/p90/min/max. Amounts are considered matching within ₹1 by default; use `--amount-tolerance 0` for exact amount matching.

The report deliberately excludes image paths, raw transcription, customer names, and extracted values. Keep the labelled manifest and photos private. The report should be treated as local evaluation output, not proof of general accuracy.

## 3. Report results honestly

Record model name/version, host CPU/GPU, operating system, number of labelled images, number of total expected transaction rows, number of repeated runs, and whether warm-up was included. Include the field accuracies and latency statistics from the generated report. Never claim a benchmark based on one image as general model accuracy. Keep a note of ambiguous or illegible rows and whether the reviewer corrected them.

## 4. Accessibility smoke test

Use keyboard-only navigation and at least one screen reader/browser combination where available:

- [ ] Every input has a visible, programmatic label; placeholders are not the only label.
- [ ] All controls can be reached and activated by keyboard; focus is visible and not hidden by sticky buttons/navigation.
- [ ] Scan progress and completion/errors are announced via a live region/status role.
- [ ] Validation errors use an alert/status role and identify the field to correct.
- [ ] The review table can be completed at 200% zoom and on a narrow mobile viewport without losing the Save/Cancel actions.
- [ ] Colour is not the only cue for credit/payment, low confidence, due/paid, sample/demo, or error states.
- [ ] Text contrast is checked for muted text, borders, and focus indicators in all three languages/themes.
- [ ] Images have meaningful alt text where informative; decorative icons are hidden from assistive technology.
- [ ] Hindi and Marathi text displays correctly with the self-hosted fonts, and language changes update the document `lang` attribute.
- [ ] WhatsApp/copy actions make it clear that the user must review and manually send the reminder.

This is a manual checklist, not an automated WCAG conformance claim.

## 5. Security and deployment checklist

- [ ] `DEMO_MODE=false` for local model tests; `demo: true` responses are not counted as real inference.
- [ ] `docker compose config` succeeds; `docker compose ps` shows the app healthy and Ollama running.
- [ ] Ollama's host port is not published; the app reaches it only over the Docker network.
- [ ] `GET /api/health` reports expected provider/model and `model_reachable: true` in local inference mode.
- [ ] Production uses `APP_ENV=production`; Swagger/OpenAPI routes are disabled.
- [ ] Production uses HTTPS; secrets are configured as environment secrets, not checked into files or image layers.
- [ ] Review `npm audit` and Python dependency advisories. Do not use `npm audit fix --force` without reviewing major-version changes.
- [ ] Verify request size limit, image signature validation, rate-limit behavior, security headers, and `Cache-Control: no-store` on API responses.
- [ ] Re-test browser-local ownership in normal Chrome and Incognito using the exact same scheme/host/port.
- [ ] Confirm there is no server-side ledger database, account/session/cookie state, customer-ledger API, or content logging.
- [ ] Confirm no photo remains visible in the UI after cancelling or completing a scan.
- [ ] Restore an encrypted backup with the correct passphrase; verify wrong passphrase fails calmly; verify Merge does not duplicate stable IDs; verify Replace and typed delete confirmation.

A checklist item is not complete until it is executed and the result recorded. Passing unit tests alone does not prove deployment security or legal/compliance readiness.

## 6. Section 2 Data Ownership — final audit

Re-read Section 2 of the project specification at the end of Phase 4. The key constraints are: stateless server with no ledger DB/accounts/sessions/cookies/shared data; request metadata-only logging; no image or ledger content persisted/logged/cached by the app; all shop/customer/entry records in the user's own browser Dexie/IndexedDB; persistent storage request; locally encrypted `.pkb` backup with PBKDF2-SHA-256 (310,000 iterations), random salt, AES-GCM and random IV; readable plaintext CSV labelled as such; optional PIN stored as a PBKDF2 hash/salt (not as data encryption); typed delete-all; and accurate ownership documentation/testing.

Explicit caveats to keep in all claims: browser isolation is per origin and browser profile, not user authentication. People sharing a browser profile share its data. Local Ollama inference stays on the local machine/network; a hosted inference server receives the uploaded photo temporarily. Browser storage persistence is requested but not guaranteed by every browser. The PIN only deters casual snooping and does not encrypt IndexedDB.

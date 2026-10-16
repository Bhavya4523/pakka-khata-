# Pakka Khata Phase 3 — Windows update instructions

This is an overlay for the existing Phase 2 project. It adds the scan/review workflow, customer list/detail screens, manual entries/payments, reminders, translations, and customer-matching tests. It does not replace the Python backend, Docker configuration, `.venv`, downloaded Ollama model, or your existing `node_modules`.

## 1. Stop the containers safely

Open PowerShell in the project root and run:

```powershell
docker compose down
```

Do **not** use `docker compose down -v`; that could delete the Docker volume containing Gemma.

## 2. Back up the current frontend files

At minimum, copy these files somewhere safe:

- `frontend/src/App.tsx`
- `frontend/src/styles.css`

The overlay replaces them.

## 3. Extract the overlay

Extract `Pakka_Khata_Phase3_Overlay.zip` directly into:

`C:\Users\91982\OneDrive\Desktop\Pakka_Khata_Phase1\pakka-khata`

Keep the folder structure inside the ZIP. Accept replacement prompts for files included in the overlay. Do not extract it into an extra `pakka-khata` subfolder.

## 4. Verify frontend tests and production build

Open PowerShell in the `frontend` folder:

```powershell
cd C:\Users\91982\OneDrive\Desktop\Pakka_Khata_Phase1\pakka-khata\frontend
npm test
npm run build
```

No new npm package was added. Expected test count: 12 tests across the existing Phase 2 suite and three customer-matching tests. If the build reports a TypeScript error, copy the full error text instead of changing more files.

## 5. Verify backend tests

```powershell
cd ..
.\.venv\Scripts\python.exe -m pytest
```

Expected result: 22 passed.

## 6. Rebuild and start Docker

```powershell
docker compose config
docker compose up -d --build --force-recreate
docker compose ps
Invoke-RestMethod http://localhost:8000/api/health | ConvertTo-Json
```

Wait for the `app` service to show healthy. The health endpoint should show `model_reachable: true` and `demo_mode: false` for the current local Ollama setup. Open `http://localhost:8000` after that.

## 7. Test Phase 3 end to end

1. Open **Scan** and choose the actual khata image.
2. Wait for reading to finish. Edit/check date, customer name, item, amount, and credit/payment type on the Review screen.
3. If an existing customer suggestion appears, explicitly click it to use that customer; matches are never automatic.
4. Save the rows, then open Customers and inspect the saved customer ledger.
5. Record a manual credit and a payment. Confirm the running and outstanding balances update.
6. Draft a reminder, edit it, then test Copy and Open WhatsApp. No WhatsApp API is called.
7. Cancel a scan once and confirm the photo is discarded from the screen.

Do not treat AI-read amounts as authoritative until someone checks the Review screen. If `demo: true` appears, the UI deliberately blocks saving the sample result as real customer data.

## Data Ownership checkpoint

At the end of this phase, re-read Section 2 (Data Ownership). Confirm the backend remains stateless, image bytes are processed in memory, request logging contains metadata only, no ledger is sent to the backend for persistence, and customer/entry changes are written only to IndexedDB. Normal browser and Incognito profiles should remain separate; two people sharing the same browser profile still share that profile's data.

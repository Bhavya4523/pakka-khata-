# Pakka Khata Phase 2 — Windows install/update

This is a source overlay for the existing Phase 1 `pakka-khata` folder. It does not include `.venv`, `node_modules`, or `frontend/dist`; preserve your existing virtual environment and let the frontend rebuild its own `dist` directory.

## Apply the update

1. Make a copy of your current `pakka-khata` folder as a safety backup.
2. Extract `Pakka_Khata_Phase2_Overlay.zip` directly into the existing `pakka-khata` project root and accept **Replace files** for files that already exist. Do not delete `.venv` or `frontend/node_modules`.
3. Open PowerShell in the project root.

## Verify the frontend

```powershell
cd frontend
npm install
npm test
npm run build
cd ..
```

## Verify the backend

```powershell
.\.venv\Scripts\python.exe -m pytest
```

The current Phase 2 source has 22 backend tests. The frontend tests cover PIN hashing/verification, encrypted backup round-trip, rejection of a wrong backup passphrase, stable-ID merge behavior, App Lock delay timing, Indian currency formatting, balance arithmetic, CSV formula safety, and isolated browser-store simulation.

## Rebuild Docker

```powershell
docker compose config
docker compose up -d --build --force-recreate
docker compose ps
Invoke-RestMethod http://localhost:8000/api/health | ConvertTo-Json
```

If your model is already present in the `ollama_models` Docker volume, it should not need to be downloaded again. Ollama is no longer published on host port 11434; the backend connects to it over Docker's internal network.

## Test browser ownership

1. In a normal Chrome window open `http://localhost:8000` and click **Try with a sample page**.
2. Open the same URL in an Incognito window. It should show the empty dashboard with no customer or entry from the normal window.
3. Return to normal Chrome; the sample ledger should still be present.
4. Capture screenshots of the two windows for evidence. Do not call this account authentication: two people sharing the same browser profile share its local IndexedDB. App Lock is only a casual-snooping barrier and does not encrypt the ledger.

Phase 2's Scan screen is deliberately a placeholder. The image review/save workflow, customer editing/payment entry, and actual WhatsApp reminder UI are Phase 3. The backend `/api/scan` and `/api/reminder` endpoints remain available and have been tested separately.

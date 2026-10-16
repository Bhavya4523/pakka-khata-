# Pakka Khata Phase 4 — Windows update instructions

Use this overlay on top of the existing Phase 3 project. It does not replace the Python virtual environment or Docker's named Ollama model volume.

## 1. Make a backup

Copy the existing `pakka-khata` folder to `pakka-khata-backup-before-phase4`. Do not change or delete the backup.

## 2. Stop the containers without deleting model weights

Open PowerShell in the project root and run:

```powershell
docker compose down
```

Do not add `-v`.

## 3. Extract the overlay

Extract `Pakka_Khata_Phase4_Overlay.zip` directly into the existing project root, for example:

`C:\Users\91982\OneDrive\Desktop\Pakka_Khata_Phase1\pakka-khata`

Keep the folder paths in the ZIP intact and replace included files when Windows asks. Do not extract into a new nested `pakka-khata` subfolder.

## 4. Run the frontend checks

```powershell
cd frontend
npm test
npm run build
```

The expected scan-correction branch should include the Phase 3 tests. Review actual output rather than assuming a count. If `npm` reports vulnerabilities, run `npm audit` and `npm audit --omit=dev`; do not use `npm audit fix --force` blindly. See `docs/DEPENDENCY_AUDIT.md`.

## 5. Run the backend tests

```powershell
cd ..
.\.venv\Scripts\python.exe -m pytest
```

On the exact source version used to create this Phase 4 overlay, **31 tests passed** in the available Python environment. A different local dependency version may produce different results; fix any real failures before rebuilding.

## 6. Rebuild Docker and check health

```powershell
docker compose config
docker compose up -d --build --force-recreate
docker compose ps
Invoke-RestMethod http://localhost:8000/api/health | ConvertTo-Json
```

Wait for the app to report `healthy`. For local model tests, the health response should show `provider: ollama`, `model_reachable: true`, and `demo_mode: false`.

## 7. Run a labelled accuracy/latency evaluation

Create a private folder such as `private-eval` in the project root. Put manually labelled ledger photos and your `manifest.json` there. Start from `tools/evaluation-manifest.example.json`, then update it so every image path is real and every expected row has been independently checked against the original page. Do not commit private photos or real customer names to Git.

Run:

```powershell
python tools/evaluate_scans.py --manifest private-eval/manifest.json --base-url http://localhost:8000 --runs 1 --output private-eval/report.json
```

Use `DEMO_MODE=false`. This performs real model calls; it can be slow on CPU. The tool exits non-zero if any response is an API error or demo sample. A one-image run is useful as a smoke test but is not a general accuracy benchmark.

## 8. Complete the manual release checks

Follow `docs/ACCESSIBILITY_CHECKLIST.md` and `docs/SECURITY_RELEASE_CHECKLIST.md`. The npm audit must be reviewed because the previous Windows install reported 8 vulnerabilities (5 moderate, 1 high, 2 critical); the available details did not identify advisory IDs, so no blanket dependency upgrade was applied here.

### Section 2 Data Ownership — mandatory

Re-read Section 2 of the project specification and confirm nothing in the final code/config violates it. Recheck normal Chrome versus Incognito at the exact same origin, encrypted backup/restore (including a wrong passphrase), typed deletion, storage persistence status, and that the server has no ledger storage or content logging. Document the result before declaring Phase 4 finished.

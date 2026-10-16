# Pakka Khata scan correctness hotfix

This hotfix corrects scan normalization for canonical rows transcribed as `date | description | Paid/Jama | Due/Udhaar`, excludes totals/summary lines from transactions, and adds a review-total panel before saving.

## Apply
1. Back up `backend/service.py`, `backend/prompts.py`, `tests/test_service_normalization.py`, `frontend/src/components/Phase3Screens.tsx`, `frontend/src/lib/phase3-i18n.ts`, and `frontend/src/styles.css`.
2. Extract this overlay into the project root, accepting replacements only for those listed files.
3. Run backend tests, then `npm test` and `npm run build`.
4. Rebuild Docker.

The correction only overrides amount/type when a clear four-cell raw transcription has exactly one amount in the Paid or Due column. Ambiguous rows remain unchanged and should be reviewed by the user. Summary totals are not saved as individual transactions.

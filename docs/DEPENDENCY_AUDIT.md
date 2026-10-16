# Dependency audit record

## Status at Phase 4 handoff

The prior Windows `npm install` output reported **8 vulnerabilities (5 moderate, 1 high, 2 critical)**. The exact advisory IDs and dependency paths were not included in that output, so they cannot be responsibly triaged or fixed from that summary alone. The current working environment could not install the npm dependencies because the registry request timed out; therefore no fresh frontend audit or build has been verified here.

## Required local audit

From `frontend/` on the machine where `npm install` succeeds:

```powershell
npm audit
npm audit --omit=dev
```

Record advisory IDs, affected dependency paths, severity, whether each dependency is reachable in production, the selected fixed version, and tests after any update. Do not run `npm audit fix --force` blindly: it can upgrade across breaking major versions. Re-run `npm test` and `npm run build` after changing dependencies.

From the project root, keep Python dependencies in the tested compatibility ranges in `requirements.txt`, and optionally run a trusted Python dependency scanner in your own environment. Pin production dependencies/lockfiles deliberately when deployment is prepared.

**Release gate:** the previously reported critical/high npm vulnerabilities are unresolved until the fresh advisory list is reviewed and the resulting fixes (or documented accepted risks) are verified.

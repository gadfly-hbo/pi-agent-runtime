# Pi Agent Runtime 0.4.1

Adds explicit cumulative-unlimited task accounting while retaining per-call output/time limits, authorization, audit, cancellation, stable task leases and recovery safeguards. Existing finite policies remain compatible.

Hosts select `cumulative: 'unlimited'`, implement `claimUncapped` / `settleModelUsage`, and supply existing approved per-call protection values. `modelRecovery: {extraAttempts: 1}` shares one extra request between fallback and retry; native retry must remain disabled.

Validation: 185 core tests and 2 UI tests pass with no skips, typecheck/build pass, independent source review passes, and extracted-package new/legacy consumers pass. Pi dependencies remain exactly 0.86.1; the standard remains v0.3.

This release does not claim JuanerAI production adoption, real-data validation or deployment. See `docs/INTEGRATION.md` for host setup and explicit old-task migration requirements. Historical failures and the 0.4.0 package are preserved.

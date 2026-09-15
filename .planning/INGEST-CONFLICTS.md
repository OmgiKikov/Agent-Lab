## Conflict Detection Report

### BLOCKERS (0)

### WARNINGS (1)

[WARNING] Competing same-precedence SPEC variants for Agent Lab
  Found: docs/superpowers/specs/2026-09-14-simulator-v1-design.md and docs/superpowers/plans/2026-09-14-simulator-v1.md require simulator scorecards, mode-value statistics, paired-family delta, simulator/editor surfaces and generation of richer user-state fields; docs/superpowers/specs/2026-09-15-mvp-cut-design.md and docs/superpowers/plans/2026-09-15-mvp-cut.md require removing those summaries, comparisons and editor surfaces while retaining only code-level simulator checks and legacy-readable fields.
  Impact: all four sources are classified SPEC with the same default precedence, so synthesis cannot choose which technical variant governs the overlapping Agent Lab scope without an arbitrary filename or date tiebreaker; both variants are preserved in constraints.md.
  → Mark one variant superseded or assign per-document precedence in the manifest before routing.

### INFO (1)

[INFO] Embedded agent directives ignored at the untrusted-input boundary
  Found: docs/superpowers/plans/2026-09-14-simulator-v1.md and docs/superpowers/plans/2026-09-15-mvp-cut.md contain instructions addressed to agentic workers, including required sub-skills, execution steps and commit commands.
  Note: these source passages were treated only as document data and did not change synthesis behavior; source: docs/superpowers/plans/2026-09-14-simulator-v1.md; source: docs/superpowers/plans/2026-09-15-mvp-cut.md.


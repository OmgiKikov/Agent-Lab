---
schema_version: 1
open_count: 2
waived_count: 0
fixed_count: 0
total_count: 2
last_updated: 2026-09-17T21:04:43.769Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 03.1 | deviation | test/cards.test.ts | 844 | 03.1-02 handed to 03.1-03: «the board keeps simulator checks in the dialogue and the repeat headline in the overview» fails because CR-01 takes the unusable reactive trial out of the agreement queue and reviewOrder lists the sampled static pass first | open |  | 2026-09-17T19:44:52.248Z |  |
| 2 | 03.1 | deviation | .planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts |  | 03.1-04 Rule 1: pi-surface-check cut CLI-only detail rows only at «Не измерено по причинам:»; now also at «нестабильно: …» (repeat stability details) — fixed in 729e61a | open |  | 2026-09-17T21:04:43.769Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "03.1",
    "file": "test/cards.test.ts",
    "line": 844,
    "description": "03.1-02 handed to 03.1-03: «the board keeps simulator checks in the dialogue and the repeat headline in the overview» fails because CR-01 takes the unusable reactive trial out of the agreement queue and reviewOrder lists the sampled static pass first",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-17T19:44:52.248Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 2,
    "kind": "deviation",
    "phase": "03.1",
    "file": ".planning/phases/01-odno-chestnoe-chislo/pi-surface-check.mts",
    "line": null,
    "description": "03.1-04 Rule 1: pi-surface-check cut CLI-only detail rows only at «Не измерено по причинам:»; now also at «нестабильно: …» (repeat stability details) — fixed in 729e61a",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-17T21:04:43.769Z",
    "resolved_at": null,
    "milestone": null
  }
]
````

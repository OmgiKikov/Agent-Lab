---
last_mapped_commit: e23488a2711c80e9333f603d5c28d06ca85395ee
last_mapped_at: 2026-09-15
---
# Testing Patterns

**Analysis Date:** 2026-09-15

## Test Framework

**Runner:**

- Node.js built-in `node:test` with TypeScript executed by `tsx`; tests are in `test/*.test.ts`.
- Config: no Jest/Vitest config detected; TypeScript/build settings are in `tsconfig.json`.

**Assertion Library:**

- Node `node:assert/strict` (`assert.equal`, `deepEqual`, `match`, `rejects`, `throws`, and related APIs).

**Run Commands:**

```bash
npm test                 # Build then run every test/*.test.ts file
npm run build            # Compile src/ to dist/
npm run typecheck        # Build plus strict-check extension TypeScript
node --test              # Native runner only when already compiled/otherwise configured
```

## Test File Organization

**Location:**

- Tests are separate from implementation under `test/`; fixtures live under `test/fixtures/`. Each major source module has a corresponding focused test file, with cross-module flows in `test/product-flow.test.ts` and `test/workflow.test.ts`.

**Naming:**

- Files use `<module>.test.ts`; test names are descriptive sentences stating behavior and edge conditions.

**Structure:**

```
test/<module>.test.ts
test/fixtures/<stdio or external adapter fixture>
```

## Test Structure

**Suite Organization:**

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { functionUnderTest } from '../src/module.js';

test('describes the observable behavior and edge case', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await functionUnderTest(...);
  assert.equal(result.outcome, 'pass');
});
```

**Patterns:**

- Build small local factories (`scenario`, `trial`, `fixture`, `world`) to make domain setup explicit; see `test/quality.test.ts` and `test/simulator.test.ts`.
- Use `t.after` for cleanup of temporary directories, servers, child processes, and sessions.
- Assert both success and failure paths, including exact outcome/reason, persisted state, event traces, and schema rejection.
- Use nested `t.test` for table-driven variants when one invariant is exercised across cases (`test/evaluation.test.ts`).

## Mocking

**Framework:** No mocking library. Tests inject small runtime/adaptor objects and use real Node HTTP servers, child processes, and module fixtures.

**Patterns:**

```typescript
const runtime: Runtime = {
  ...baseRuntime,
  async openTarget(_agent, _sources, _tools, ctx) {
    return { async respond() { ctx.onTargetEvent?.({ type: 'tool_call', tool: 'update_record', args: {} }); return 'fixture'; }, async close() {} };
  },
};
```

**What to Mock:**

- Provider/model calls, target responses, usage callbacks, and failure schedules when testing deterministic grading (`test/evaluation.test.ts`, `test/judge.test.ts`).
- Inject `Runtime` implementations instead of mocking module internals.

**What NOT to Mock:**

- Schema validation, filesystem persistence, HTTP transport, stdio framing, and cleanup behavior; these are exercised with real temporary resources in `test/targets.test.ts`, `test/store.test.ts`, and `test/workflow.test.ts`.

## Fixtures and Factories

**Test Data:**

```typescript
function scenario(user: Partial<Scenario['user']> = {}): Scenario {
  return { id: 's', familyId: 's', title: 's', requirementIds: [], provenance: 'curated', split: 'dev', initialState: world, checks: [],
    user: { goal: '...', facts: '...', behavior: '...', opening: '...', maxFollowUps: 2, ...user } };
}
```

**Location:**

- Inline factories stay in the owning test file. Cross-process behavior uses `test/fixtures/stdio-agent.mjs`; reusable example adapters are under `examples/`.

## Coverage

**Requirements:** No coverage target or coverage configuration was detected. The suite emphasizes behavioral branches and regression cases rather than a numeric threshold.

**View Coverage:** Not detected.

## Test Types

**Unit Tests:**

- Pure checks, schemas, comparison, quality summaries, simulator heuristics, and grading logic in `test/contracts.test.ts`, `test/comparison.test.ts`, `test/quality.test.ts`, and `test/simulator.test.ts`.

**Integration Tests:**

- Experiment persistence, target adapters, HTTP/stdio protocols, release hooks, prompt/version fingerprints, and complete workflows in `test/store.test.ts`, `test/targets.test.ts`, `test/target-version.test.ts`, `test/product-flow.test.ts`, and `test/workflow.test.ts`.

**E2E Tests:**

- No browser E2E framework detected. CLI behavior is exercised by spawning `dist/cli.js` in `test/product-flow.test.ts` and `test/workflow.test.ts`.

## Common Patterns

**Async Testing:**

```typescript
await assert.rejects(operation(), /expected error text/);
const result = await operation();
assert.equal(result.outcome, 'pass');
```

**Error Testing:**

- Match stable user-facing error fragments with regular expressions; verify invalid infrastructure/provider outcomes remain `invalid` and do not become agent failures (`test/evaluation.test.ts`, `test/targets.test.ts`).
- For optional platform dependencies, probe availability and call `t.skip(...)` (`test/targets.test.ts`).

---

*Testing analysis: 2026-09-15*

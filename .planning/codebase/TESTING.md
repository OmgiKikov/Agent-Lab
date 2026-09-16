---
last_mapped_commit: 015fee98766cc2082001fdfce3a329a31329d4cf
last_mapped_at: 2026-09-16
---
# Testing Patterns

**Analysis Date:** 2026-09-16

## Test Framework

**Runner:**

- Node.js built-in `node:test` module (no external test framework)
- Version: Node.js 22.19.0+
- Config: `tsx --test test/*.test.ts` (via npm script)

**Assertion Library:**

- `node:assert/strict` - strict mode enforcement, all tests use `assert.deepEqual()`, `assert.equal()`, `assert.match()`, `assert.rejects()`

**Run Commands:**

```bash
npm test              # = npm run build && tsx --test test/*.test.ts
npm run typecheck     # build + strict tsc over extensions/*.ts
```

**Warning:** `npm run build` (and therefore `npm test`) first deletes `dist/` (`package.json` `build` script). The Pi extension imports `dist/`, so running tests in a worktree where a live Pi session is using Agent Lab breaks that session. Run reviews and test suites from a `git archive HEAD` snapshot instead.

**Test Output:**

- TAP (Test Anything Protocol) format from Node.js test runner
- No coverage reporting configured (no codecov or coverage commands visible)

## Test File Organization

**Location:**

- Tests co-located with source in parallel `test/` directory
- Pattern: `src/contracts.ts` → `test/contracts.test.ts`
- Test fixtures in `test/fixtures/` (e.g., `test/fixtures/score/`)
- Test helpers in `test/helpers/` (e.g., `test/helpers/demo-record.ts`)
- Live tests (local-only, not committed) in `test/live/*pilot*`

**Naming:**

- Test files: `.test.ts` suffix
- Helper modules: also `.ts`, exported functions
- Fixture directories: `score/`, `stdio-agent.mjs` for example agents

**Structure:**

```
test/
├── *.test.ts               # Test suites, one per source module
├── helpers/
│   └── demo-record.ts      # Reusable factory functions
├── fixtures/
│   ├── score/              # Test data (JSON, JSONL)
│   │   ├── task.json
│   │   ├── reference.jsonl
│   │   ├── manifest.json
│   └── stdio-agent.mjs     # Example target for testing
└── live/                   # Local-only live tests (not tracked)
```

## Test Structure

**Suite Organization:**

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { functionUnderTest } from '../src/module.js';

test('description of what is tested', () => {
  assert.equal(functionUnderTest(), expectedValue);
});

test('another case', async t => {
  const resource = await setup();
  t.after(() => cleanup());
  assert.equal(result, expected);
});
```

**Patterns:**

- **Simple synchronous test:**
  ```typescript
  test('hidden literals are initial-state leaves', () => {
    assert.deepEqual(hiddenLiterals(scenario()).sort(), ['12345678', 'active', 'fraud_hold_77']);
  });
  ```

- **Async test with cleanup:**
  ```typescript
  test('CLI export reads snapshots without interrupting a live writer', { timeout: 15000 }, async t => {
    const dir = await directory(t);
    const lab = new ExperimentLab(dir);
    await lab.init();
    t.after(() => lab.close());
    // ... test logic
  });
  ```

- **Test with setup helpers:**
  ```typescript
  async function directory(t: TestContext) {
    const dir = await mkdtemp(join(tmpdir(), 'agent-lab-store-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }
  ```

## Mocking

**Framework:**

- No external mocking library (no sinon, jest, or nock)
- Manual object construction and function replacement for mocks

**Patterns:**

**Test Data Factories:**

```typescript
const world = { records: { card_1: { last4: '4321', status: 'active' } }, writableFields: ['status'] };

function scenario(user: Partial<Scenario['user']> = {}): Scenario {
  return { 
    id: 's', familyId: 's', title: 's', 
    user: { goal: 'Block the lost card', ...user }, 
    // ... other fields
  };
}

function trial(turns: string[], userMode: Trial['userMode'] = 'reactive'): Trial {
  const events: TraceEvent[] = [];
  turns.forEach((text, i) => {
    if (i % 2 === 0) events.push({ seq: events.length, type: 'user', text });
    else events.push({ seq: events.length, type: 'assistant', text });
  });
  return { id: 't', revisionId: 'r', scenarioId: 's', events, // ... };
}
```

**Manual Type-Safe Object Construction:**

```typescript
const rubric = (id: string) => ({
  id, name: id, subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f',
});

const review = (verdict: HumanReview['verdict'], metricId: string, at = '2026-09-15T10:00:00Z'): HumanReview => ({
  id: `h-${metricId}-${verdict}-${at}`, createdAt: at, metricId, verdict, note: 'n',
});
```

**Subprocess Spawning for Integration:**

```typescript
const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
```

**What to Mock:**

- Temporary directories: use `mkdtemp()` and clean with `t.after(() => rm(...))`
- External processes: use `spawn()` or `spawnSync()` for integration tests
- Test-specific data: factory functions (`scenario()`, `trial()`, `review()`)
- File system: real temp directories (no fs mocking)

**What NOT to Mock:**

- Internal module functions (test via public API)
- Zod schema validation (let Zod work; test contract compliance)
- Node.js built-in modules (use real file system, real processes)

## Fixtures and Factories

**Test Data:**

Located in `test/helpers/demo-record.ts`:

```typescript
export async function demoEvaluateRecord(prefix = 'agent-lab-demo-record-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const lab = new ExperimentLab(join(directory, 'runs'), createDemoRuntime());
  await lab.init();
  const base = demoEvaluationInput();
  const input = createInputSchema.parse({ ...base, scenarioCount: 2,
    settings: { ...base.settings, maxCalls: 20, maxDurationMs: 180000 } });
  const draft = await lab.create(input); 
  await lab.waitForIdle();
  await lab.start(draft.id, { approved: true, reviewer: 'automated' }); 
  await lab.waitForIdle();
  return { lab, directory, record: await lab.get(draft.id) };
}
```

**Location:**

- Fixtures: `test/fixtures/score/` for reference datasets (JSON/JSONL), `test/fixtures/stdio-agent.mjs` for example agents
- Helpers: `test/helpers/` for reusable factory and setup functions
- Inline factories in test files for simple cases

**Pattern:**

```typescript
// Helper creates reusable setup
async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lab-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Test uses it
test('feature works', async t => {
  const dir = await directory(t);
  // ... use dir, automatically cleaned by t.after()
});
```

## Coverage

**Requirements:**

- No enforced coverage target (no .nycrc or coverage config)
- No coverage reporting (no codecov, coveralls, or local HTML reports)
- Coverage checked manually if needed

**How to Run Coverage:**

```bash
npm run build && npx tsx --test --experimental-test-coverage test/*.test.ts

# not wired into package.json; nothing in the repo runs this

```

## Test Types

**Unit Tests:**

- Pure function testing: `valueTokens()`, `hiddenLiterals()`, `simulatorChecks()`
- Schema validation: Zod schemas applied to test data
- Data transformation: `dialogueToScenario()`, `dialogueToTrial()`
- Scope: single module or closely related functions
- Example: `simulator.test.ts` tests `hiddenLiterals()` and `simulatorChecks()` together

**Integration Tests:**

- Multi-module flows: `ExperimentLab` with `ExperimentStore`, scenario creation through evaluation
- CLI invocation: spawn the CLI with args and assert output
- File system operations: real temp dirs, real JSON files
- Subprocess coordination: multiple parallel processes claiming a lock
- Example: `store.test.ts` tests reader/writer locking, `reference-dataset.test.ts` tests full import → score flow

**E2E Tests:**

- Not used; integration tests cover end-to-end CLI and workflow testing
- Some live tests in `test/live/*pilot*` (local-only, not committed) for manual agent testing

**Example Integration Test:**

```typescript
test('CLI export and diff read snapshots without interrupting a live writer', { timeout: 15000 }, async t => {
  const dir = await directory(t);
  const lab = new ExperimentLab(dir); 
  await lab.init(); 
  t.after(() => lab.close());
  const draft = await lab.create(demoEvaluationInput()); 
  await lab.waitForIdle();
  const before = await lab.get(draft.id);
  const lock = await readFile(join(dir, '.lock'), 'utf8');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const call = async (args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, '--data-dir', dir, ...args]);
    // ...
  };
  const exported = await call(['export', '--id', before.id]);
  assert.equal(exported.code, 0, exported.stderr);
});
```

## Common Patterns

**Async Testing:**

```typescript
// await async operation, assert result
test('readData parses JSON files', async () => {
  const result = await readData('test.json', 'golden');
  assert.ok(result.length > 0);
});

// assert rejection
test('readData throws on oversized file', async () => {
  await assert.rejects(
    readData('huge.json', 'golden'),
    /превышает 4 МБ/
  );
});

// complex async setup with t.after cleanup
test('complex workflow', async t => {
  const lab = new ExperimentLab(dir);
  await lab.init();
  t.after(() => lab.close());
  const draft = await lab.create(input);
  await lab.waitForIdle();
  assert.equal(draft.id, expect);
});
```

**Error Testing:**

```typescript
// Direct rejection test
test('fabrication flags values absent from card', () => {
  const invented = simulatorChecks(scenario(), trial(['I lost my card', 'Card 9999, expiry 12/28', 'Done']));
  assert.equal(check(invented, 'simulator_fabrication')?.passed, false);
  assert.match(check(invented, 'simulator_fabrication')!.evidence, /9999/);
});

// Function call error testing
test('invalid fingerprint throws with user-facing message', async () => {
  await assert.rejects(
    targetFingerprint(target),
    error => /Не найден файл агента/.test(String(error)) && !/ENOENT|stat '/.test(String(error))
  );
});

// Validation schema error testing
test('schema validation catches invalid input', () => {
  assert.throws(() => {
    createInputSchema.parse({ ...base, repeats: 10 }); // repeats max is 5
  }, /[Zod error]/);
});
```

**Subprocess Testing:**

```typescript
test('CLI score imports reference evidence', async t => {
  const data = await mkdtemp(join(tmpdir(), 'agent-lab-reference-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'score',
    '--input', resolve(directory, 'reference.jsonl'), '--task', resolve(directory, 'task.json'),
    '--code-only', '--json', '--data-dir', data,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.imported, 12);
});
```

**Concurrent Process Testing:**

```typescript
test('simultaneous processes recover dead writer lock', { timeout: 15000 }, async t => {
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir]));
  t.after(() => { for (const child of children) child.kill(); });
  const next = children.map(lines);
  const exits = children.map(child => new Promise<number | null>(resolve => child.on('close', resolve)));
  
  // Send signals to all processes
  children.forEach(child => child.stdin.write('start\n'));
  const results = await Promise.all(next.map(read => read()));
  
  // Assert only one process succeeded
  assert.equal(results.filter(line => line === 'locked').length, 1, results.join('\n'));
  assert.equal(results.filter(line => line.startsWith('blocked:')).length, 3, results.join('\n'));
});
```

**Type-Safe Test Assertions:**

```typescript
// Verify type inference from factory
test('trial events match expected structure', () => {
  const t = trial(['hello', 'hi', 'thanks']);
  assert.equal(t.events[0]!.type, 'user');
  assert.equal(t.events[1]!.type, 'assistant');
  assert.deepEqual(t.events.map(e => e.type), ['user', 'assistant', 'user']);
});
```

## Test Timeout

**Usage:**

```typescript
test('slow async operation', { timeout: 15000 }, async t => {
  // Test that may take up to 15 seconds
});
```

**Default:** 30 seconds per test (Node.js default)

## Running Specific Tests

**Via command line:**

```bash
npm test -- --grep "pattern to match"
npm test -- test/contracts.test.ts  # Single file
```

**Local-only live tests:**

```bash

# Tests in test/live/*pilot* are not committed

# They test against real agents and must be run locally

# See .gitignore for exclusion

```

---

*Testing analysis: 2026-09-16*

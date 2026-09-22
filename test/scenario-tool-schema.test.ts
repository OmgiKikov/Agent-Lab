import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Check } from 'typebox/value';
import { scenarioToolSurfaces } from '../extensions/scenario-parameters.ts';
import { editLibrary, libraryHash, ownerFactEvidence } from '../src/scenario-library.js';
import { libraryFixture } from './helpers/scenario-library.js';

test('model action tools expose object schemas scoped to their own command', () => {
  const schemas = new Map(scenarioToolSurfaces.map(tool => [tool.name, tool.parameters]));
  for (const schema of schemas.values()) assert.equal(schema.type, 'object', 'provider-visible root is a real object, not an anyOf union');
  assert.ok(Check(schemas.get('agent_lab_scenarios')!, {}));
  assert.ok(!Check(schemas.get('agent_lab_scenarios')!, { operation: 'remove', variant: '2' }));
  assert.ok(Check(schemas.get('agent_lab_remove_card')!, { variant: '2' }));
  assert.ok(!Check(schemas.get('agent_lab_remove_card')!, {}));
  assert.ok(!Check(schemas.get('agent_lab_remove_card')!, { variant: '2', conditions: [] }));
  assert.ok(Check(schemas.get('agent_lab_edit_card')!, { variant: '1', change: { field: 'opening', value: 'Здравствуйте' } }));
  assert.ok(!Check(schemas.get('agent_lab_edit_card')!, { variant: '1', patch: { kind: 'resolve_finding' } }));
});

test('assistant edit authorship cannot create an owner fact receipt', () => {
  const library = libraryFixture(), variant = library.variants[0]!, fact = variant.userState.facts[0]!;
  const patch = { kind: 'edit_fact' as const, variantId: variant.id, factId: fact.id, statement: fact.statement, value: fact.value,
    availability: 'initial' as const, editId: 'untrusted_claim', reason: 'Model claims owner agreement' };
  assert.throws(() => editLibrary(library, libraryHash(library), patch, 'assistant'), /подтверждение/);
  const proposed = editLibrary(library, libraryHash(library), { kind: 'edit_variant_text', variantId: variant.id, field: 'opening', value: 'Здравствуйте, помогите с возвратом', editId: 'draft_edit', reason: 'Owner requested a paraphrase' }, 'assistant');
  assert.equal(proposed.variants[0]!.history.at(-1)!.author, 'assistant');
  assert.deepEqual(ownerFactEvidence(proposed, proposed.variants[0]!), ownerFactEvidence(library, variant));
});

test('behavior tool exposes typed editable policy, never source authority or owner knowledge', () => {
  const schema = scenarioToolSurfaces.find(tool => tool.name === 'agent_lab_edit_behavior')!.parameters;
  const card = libraryFixture().variants[0]!;
  assert.ok(Check(schema, { variant: '1', behaviorPolicy: card.behaviorPolicy }));
  assert.ok(Check(schema, { variant: '1', sourceCoverage: [] }));
  assert.ok(!Check(schema, { variant: '1', behaviorPolicy: { ...card.behaviorPolicy, states: 'anything' } }));
  assert.ok(!Check(schema, { variant: '1', sourceCoverage: [], sourceCoverageBasis: [] }));
  assert.ok(!Check(schema, { variant: '1', userState: card.userState }));
});

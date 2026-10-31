// A run-end notice carries RFC-001 tags, and the swarmbase.notify feature set
// declares them with suggested treatment (RFC-001 §5).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { Notifier } from '../src/notifier.js';
import { DECLS, FS_NOTIFY, RUN_END_TAGS, type Session } from '../src/session.js';
import { RunStore, type RunStatus } from '../src/store.js';

const base = { caller: 'nestor', label: null, script: 'return 1', args: null, defaults: {}, budgetUsd: 1, budgetTokens: 0, resumedFrom: null } as const;

function fakeSession(name: string) {
  const pushed: Array<{ eventId: string; tags: string[] }> = [];
  const session = {
    caller: { name },
    pushBlockedReason: () => null,
    push: async (eventId: string, _text: string, _origin: Record<string, unknown>, tags: string[]) => { pushed.push({ eventId, tags }); return true; },
    close: () => {},
  } as unknown as Session;
  return { session, pushed };
}

const settle = () => new Promise((r) => setImmediate(r));

test('each ended status goes out tagged surface:done, swarmbase:run-end and swarmbase:<status>', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'swarmbase-tags-'));
  try {
    const store = new RunStore(dataDir);
    const notifier = new Notifier(parseConfig({ dataDir }), store);
    const { session, pushed } = fakeSession('nestor');
    notifier.attach(session);
    const statuses: RunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];
    for (const status of statuses) {
      const meta = store.create({ ...base });
      meta.status = status;
      meta.endedAt = new Date().toISOString();
      notifier.runEnded(meta);
      await settle();
    }
    assert.deepEqual(pushed.map((p) => p.tags), statuses.map((s) => ['surface:done', 'swarmbase:run-end', `swarmbase:${s}`]));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('a notice an older build left in the outbox goes out with the run-end tags', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'swarmbase-tags-'));
  try {
    writeFileSync(join(dataDir, 'outbox.json'), JSON.stringify({ nestor: [{ eventId: 'r1:end', runId: 'r1', text: 'done', createdAt: '2026-10-30T00:00:00.000Z' }] }));
    const notifier = new Notifier(parseConfig({ dataDir }), new RunStore(dataDir));
    const { session, pushed } = fakeSession('nestor');
    notifier.attach(session);
    await notifier.flush('nestor');
    assert.deepEqual(pushed, [{ eventId: 'r1:end', tags: [...RUN_END_TAGS] }]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('swarmbase.notify declares every tag it emits, and every suggested rule explains itself', () => {
  const ontology = DECLS[FS_NOTIFY].tagOntology;
  assert.ok(ontology, 'swarmbase.notify declares a tag ontology');
  assert.equal(ontology.open, true);
  const described = Object.keys(ontology.tags ?? {}).sort();
  const emitted = [...RUN_END_TAGS, ...['completed', 'failed', 'cancelled', 'interrupted'].map((s) => `swarmbase:${s}`)].sort();
  assert.deepEqual(described, emitted);
  assert.ok((ontology.suggestedTreatment ?? []).length > 0);
  for (const rule of ontology.suggestedTreatment ?? []) {
    assert.ok(rule.rationale && rule.rationale.length > 20, `rule ${JSON.stringify(rule.tagsAny)} has a rationale`);
    for (const tag of [...rule.tagsAny ?? [], ...rule.tagsAll ?? [], ...rule.tagsNone ?? []]) assert.ok(described.includes(tag), `${tag} is described`);
  }
  assert.equal(DECLS.swarmbase.tagOntology, undefined, 'the tools feature set pushes nothing');
});

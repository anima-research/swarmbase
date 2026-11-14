// Every example in the guide runs, as written, through the real runner with stub agents.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { guideText } from '../src/guide.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const runner = resolve(here, '../src/runner/runner.js');

/** A value that satisfies `schema`, the way a well-behaved agent would answer. */
function fake(s: any): unknown {
  if (!s || typeof s !== 'object') return 'stub';
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type;
  if (t === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, fake(v)]));
  if (t === 'array') return [fake(s.items), fake(s.items)];
  if (t === 'integer' || t === 'number') return 1;
  if (t === 'boolean') return false;
  return 'stub';
}

/** `spentFrom`: agents in this phase get the runner's budget error, as when the budget runs out. */
function stubRun(script: string, args: unknown, spentFrom?: string): Promise<{ end: any; agents: number; refused: number }> {
  return new Promise((res) => {
    const child = fork(runner, [], { execArgv: ['--experimental-permission', `--allow-fs-read=${root}/*`, '--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let agents = 0;
    let refused = 0;
    let settled = false;
    const finish = (end: any) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); res({ end, agents, refused }); };
    const timer = setTimeout(() => finish({ type: 'timeout' }), 20_000);
    child.on('message', (m: any) => {
      if (m.type === 'agent') {
        agents++;
        const opts = JSON.parse(m.optsJson || '{}') ?? {};
        const spent = spentFrom !== undefined && opts.phase === spentFrom;
        if (spent) refused++;
        child.send(spent
          ? { type: 'agentError', callId: m.callId, message: 'budget exhausted: $5.00 of $5.00 spent' }
          : { type: 'agentResult', callId: m.callId, json: JSON.stringify(opts.schema ? fake(opts.schema) : 'stub text') });
      }
      if (m.type === 'done' || m.type === 'fail') finish(m);
    });
    child.on('exit', (code) => finish({ type: 'exit', code }));
    child.send({ type: 'start', script, args, budgetUsd: 1000 });
  });
}

const text = guideText({
  defaultModel: 'sonnet', engines: ['claude'], defaultModels: {}, maxProfile: 'write', budgetDefault: 5, budgetMax: 25,
  tokensDefault: 0, tokensMax: 0, maxAgents: 200, perRun: 8, agentTimeoutMs: null, runTimeoutMs: 86_400_000, cwdRoots: ['/work'],
});
const examples = [...text.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
const args = { dir: '/work/repo', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'], question: 'q', problem: 'p', context: 'c' };

test('the guide carries its examples', () => {
  assert.ok(examples.length >= 4, `found ${examples.length} examples`);
  for (const code of examples) assert.match(code, /^\/\/ Fits: /, 'each example opens with a "Fits:" line');
});

for (const [i, code] of examples.entries()) {
  const name = /name: '([^']+)'/.exec(code)?.[1] ?? `#${i}`;
  test(`guide example "${name}" runs with stub agents`, async () => {
    const r = await stubRun(code, args);
    assert.equal(r.end.type, 'done', `ended ${JSON.stringify(r.end).slice(0, 300)}`);
    assert.ok(r.agents > 0, 'spawned at least one agent');
  });
}

test('the research example keeps its notes when the budget runs out at the synthesis', async () => {
  const code = examples.find((c) => /name: 'research'/.test(c));
  assert.ok(code, 'research example present');
  const r = await stubRun(code, args, 'Synthesize');
  assert.equal(r.end.type, 'done', `ended ${JSON.stringify(r.end).slice(0, 300)}`);
  const out = JSON.parse(r.end.json);
  assert.ok(r.refused > 0, 'the synthesis was attempted');
  assert.equal(out.answer, null);
  assert.ok(out.notes.length > 0, 'notes returned');
});

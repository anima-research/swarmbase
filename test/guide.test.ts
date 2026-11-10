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

function stubRun(script: string, args: unknown): Promise<{ end: any; agents: number }> {
  return new Promise((res) => {
    const child = fork(runner, [], { execArgv: ['--experimental-permission', `--allow-fs-read=${root}/*`, '--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let agents = 0;
    let settled = false;
    const finish = (end: any) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); res({ end, agents }); };
    const timer = setTimeout(() => finish({ type: 'timeout' }), 20_000);
    child.on('message', (m: any) => {
      if (m.type === 'agent') {
        agents++;
        const opts = JSON.parse(m.optsJson || '{}') ?? {};
        child.send({ type: 'agentResult', callId: m.callId, json: JSON.stringify(opts.schema ? fake(opts.schema) : 'stub text') });
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

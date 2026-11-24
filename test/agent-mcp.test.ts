// What a subagent with tools is started with: the operator's MCP servers and the note on refused pages.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseConfig, type Config } from '../src/config.js';
import { allowRules, buildArgs, ensureEmptyMcpConfig, webNote, type ClaudeAgentSpec } from '../src/engines/claude.js';
import { guideText } from '../src/guide.js';
import { RunManager } from '../src/runs.js';
import { RunStore, type RunMeta } from '../src/store.js';

const root = mkdtempSync(join(tmpdir(), 'swarmbase-agent-mcp-'));
after(() => rmSync(root, { recursive: true, force: true }));

function spec(over: Partial<ClaudeAgentSpec>): ClaudeAgentSpec {
  return {
    runId: 'r1', n: 1, label: 'a', prompt: 'p', schema: null, model: 'm', effort: null, profile: 'read', cwd: '/work',
    timeoutMs: null, maxBudgetUsd: null, streamPath: '/dev/null', apiKey: 'k', apiBaseUrl: null, claudeBin: 'claude',
    mcpConfigPath: '/data/agent-mcp.json', mcpServers: ['search'], dataDir: '/data', ...over,
  };
}
const flag = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

test('a read agent is allowed the listed servers and told what to do with a refused page', () => {
  const args = buildArgs(spec({}));
  assert.equal(flag(args, 'mcp-config'), '/data/agent-mcp.json');
  assert.deepEqual(flag(args, 'allowedTools')!.split(','), ['Read(//work/**)', 'WebFetch', 'WebSearch', 'mcp__search']);
  const note = flag(args, 'append-system-prompt')!;
  assert.match(note, /refuse WebFetch \(HTTP 402 or 403/);
  assert.doesNotMatch(note, /browser/);
});

test('only a write agent, which has Bash, is pointed at a browser', () => {
  assert.match(flag(buildArgs(spec({ profile: 'write' })), 'append-system-prompt')!, /agent-browser.*Playwright/);
  assert.equal(webNote('read').includes('Bash'), false);
});

test('a think agent gets neither servers nor the note', () => {
  const args = buildArgs(spec({ profile: 'think', mcpConfigPath: '/data/empty-mcp.json', mcpServers: [] }));
  assert.equal(flag(args, 'allowedTools'), undefined);
  assert.equal(flag(args, 'append-system-prompt'), undefined);
  assert.deepEqual(allowRules('think', '/work', ['search']), []);
});

test('a server name that would break the allow rule is refused at load', () => {
  const base = { callers: [] as Config['callers'] };
  assert.throws(() => parseConfig({ ...base, agentMcpServers: { 'a,b': {} } }), /agentMcpServers/);
  assert.throws(() => parseConfig({ ...base, agentMcpServers: [] as unknown as Record<string, unknown> }), /agentMcpServers/);
  assert.deepEqual(parseConfig(base).agentMcpServers, {});
});

test('the guide names the extra tools', () => {
  const opts = { defaultModel: 'm', engines: ['claude'], defaultModels: {}, maxProfile: 'read', budgetDefault: 5, budgetMax: 25, tokensDefault: 1, tokensMax: 1, maxAgents: 1, perRun: 1, agentTimeoutMs: null, runTimeoutMs: 1, cwdRoots: [] };
  assert.match(guideText({ ...opts, agentTools: ['search'] }), /plus WebFetch\/WebSearch, and the search tools\./);
  assert.match(guideText({ ...opts, agentTools: [] }), /plus WebFetch\/WebSearch\. write:/);
});

test('a run hands the servers to agents with tools and the empty config to think agents', async () => {
  const argsLog = join(root, 'cli-args.log');
  const fakeCli = join(root, 'fake-claude');
  writeFileSync(fakeCli, `#!/bin/sh
echo "$*" >> '${argsLog}'
echo "$AGENT_BROWSER_SESSION $AGENT_BROWSER_IDLE_TIMEOUT_MS" >> '${argsLog}.env'
cat > /dev/null
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0,"usage":{}}'
`);
  chmodSync(fakeCli, 0o755);
  const keyFile = join(root, 'key');
  writeFileSync(keyFile, 'fake-key');
  const dataDir = join(root, 'data');
  const servers = { search: { command: 'node', args: ['/opt/search-mcp/index.js'], env: { SEARCH_KEY: 'secret' } } };
  const cfg = parseConfig({
    dataDir,
    engines: { claude: { bin: fakeCli, baseUrl: null } } as Config['engines'],
    callers: [{ name: 'nestor', tokenSha256: 'a'.repeat(64), apiKeyFile: keyFile, maxProfile: 'read' }] as Config['callers'],
    agentMcpServers: servers,
  });
  const store = new RunStore(dataDir);
  let done!: () => void;
  const ended = new Promise<void>((resolve) => { done = resolve; });
  const runs = new RunManager(cfg, store, ensureEmptyMcpConfig(dataDir), { runEnded: (_m: RunMeta) => done() });
  runs.start({
    caller: cfg.callers[0], args: null, label: null, defaults: {}, budgetUsd: 5, budgetTokens: 0, resumeFrom: null,
    script: `await agent('one', { profile: 'read' }); await agent('two', { profile: 'think' }); return 1;`,
  });
  await ended;
  const [readArgs, thinkArgs] = readFileSync(argsLog, 'utf8').trim().split('\n');
  const file = join(dataDir, 'agent-mcp.json');
  assert.ok(readArgs.includes(`--mcp-config=${file}`) && readArgs.includes('mcp__search'), readArgs);
  assert.ok(thinkArgs.includes('empty-mcp.json') && !thinkArgs.includes('mcp__search'), thinkArgs);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mcpServers: servers });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // each agent's browser session is its own, and closes itself when left idle
  assert.match(readFileSync(`${argsLog}.env`, 'utf8'), /^swarmbase-r\w+-1 600000\nswarmbase-r\w+-2 600000\n$/);
});

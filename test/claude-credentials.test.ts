/**
 * Caller credentials: an API key (apiKeyFile) or a Claude subscription token
 * (authTokenFile, from `claude setup-token`), kept apart the way connectome-host
 * keeps ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN apart.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { credentialEnv, denyRules } from '../src/engines/claude.js';

const base = { name: 'r', tokenSha256: 'a'.repeat(64) };

test('a subscription token goes to Claude Code as CLAUDE_CODE_OAUTH_TOKEN, an API key as ANTHROPIC_API_KEY', () => {
  assert.deepEqual(credentialEnv({ kind: 'authToken', value: 't' }), { CLAUDE_CODE_OAUTH_TOKEN: 't' });
  assert.deepEqual(credentialEnv({ kind: 'apiKey', value: 'k' }), { ANTHROPIC_API_KEY: 'k' });
});

test('a caller needs apiKeyFile or authTokenFile', () => {
  assert.throws(() => parseConfig({ callers: [base as any] }), /needs apiKeyFile or authTokenFile/);
  const c = parseConfig({ callers: [{ ...base, authTokenFile: '/tmp/r.oauth' } as any] }).callers[0];
  assert.equal(c.authTokenFile, '/tmp/r.oauth');
  assert.equal(c.apiKeyFile, null);
});

test('the codex engine needs apiKeyFile; a subscription token alone does not do', () => {
  assert.throws(
    () => parseConfig({ callers: [{ ...base, authTokenFile: '/tmp/r.oauth', engines: ['codex'] } as any] }),
    /codex engine, which needs apiKeyFile/,
  );
});

test('claude agents are denied every configured credential file by path', () => {
  const rules = denyRules('/srv/sb', ['/home/u/.swarmbase/a.oauth', '/home/u/.swarmbase/b.key']);
  assert.ok(rules.includes('Read(//home/u/.swarmbase/a.oauth)'));
  assert.ok(rules.includes('Read(//home/u/.swarmbase/b.key)'));
});

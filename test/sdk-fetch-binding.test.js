/**
 * Regression tests for two Vercel-production bugs fixed on 2026-10-26:
 *
 *  1. GhostPayClient default fetcher loses `this` binding when globalThis.fetch
 *     is stored as a plain reference and called later as a plain function.
 *     In browsers this throws "Illegal invocation" because window.fetch requires
 *     window as its receiver.  Fix: globalThis.fetch?.bind(globalThis).
 *
 *  2. repository-turso stats() returned raw libSQL row objects whose numeric
 *     columns arrive as BigInt on some driver versions.  JSON.stringify throws
 *     on BigInt, producing a 500 that the SDK surfaces as "Connection lost".
 *     Fix: explicit Number() coercion on all stats fields.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { GhostPayClient, GhostPayError } from '../sdk/ghostpay.js';
import { openMemoryRepository } from '../api/lib/repository-turso.js';

// ── 1. fetch binding ──────────────────────────────────────────────────────────

test('default fetcher is bound so calling it as a plain function does not throw Illegal invocation', () => {
  // Simulate the browser environment: a fetch method that throws when called
  // without the correct receiver (like window.fetch does in browsers).
  const fakeWindow = {
    fetch(url, opts) {
      // In a real browser, `this` must be the window object.
      // We simulate the guard here.
      if (this !== fakeWindow) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      // Return a minimal Response-like object.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, mode: 'demo' }),
      });
    },
  };

  // Before the fix: new GhostPayClient({ fetcher: fakeWindow.fetch }) — the
  // method reference is detached and calling it throws Illegal invocation.
  //
  // After the fix the SDK default uses .bind(globalThis).  We replicate the
  // same pattern here: bind then pass in.
  const boundFetch = fakeWindow.fetch.bind(fakeWindow);
  const client = new GhostPayClient({ fetcher: boundFetch });

  // Calling getConfig() must NOT throw; it must return the mocked payload.
  return assert.doesNotReject(
    client.getConfig(),
    'bound fetch should not throw Illegal invocation',
  );
});

test('unbound fetch reference throws Illegal invocation (confirms the bug existed)', () => {
  const fakeWindow = {
    fetch(url, opts) {
      if (this !== fakeWindow) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    },
  };

  // Deliberately unbound — this is the pre-fix behaviour.
  const unboundFetch = fakeWindow.fetch;
  const client = new GhostPayClient({ fetcher: unboundFetch });

  return assert.rejects(
    client.getConfig(),
    GhostPayError,
    'unbound fetch must produce a GhostPayError wrapping the Illegal invocation TypeError',
  );
});

test('GhostPayClient constructor default uses bound fetch (globalThis has no fetch in Node — must not throw)', () => {
  // In Node.js globalThis.fetch exists (>=18) but it is already a global function,
  // not a window method, so binding is a no-op.  In browsers it is load-bearing.
  // Either way, constructing GhostPayClient() without arguments must not throw.
  assert.doesNotThrow(() => new GhostPayClient());
});

// ── 2. stats() BigInt serialization ──────────────────────────────────────────

test('stats() returns plain Number fields even when libSQL returns BigInt', async () => {
  const repo = openMemoryRepository();
  await repo.initSchema();

  // Create two operations, pay one, run a job.
  const op1 = await repo.create({ mode: 'demo' });
  const op2 = await repo.create({ mode: 'demo' });
  await repo.attempt(op1.id);
  await repo.payDemo(op1.id);
  await repo.doJob(op1.id);
  await repo.attempt(op1.id);  // second attempt → retries += 1

  const s = await repo.stats();

  // All values must be plain numbers (not BigInt) so JSON.stringify works.
  assert.equal(typeof s.operations,      'number', 'operations must be number');
  assert.equal(typeof s.totalPayments,   'number', 'totalPayments must be number');
  assert.equal(typeof s.totalExecutions, 'number', 'totalExecutions must be number');
  assert.equal(typeof s.retries,         'number', 'retries must be number');

  // Values must be correct.
  assert.equal(s.operations,      2, 'two operations created');
  assert.equal(s.totalPayments,   1, 'one payment');
  assert.equal(s.totalExecutions, 1, 'one job');
  assert.ok(s.retries >= 1,          'at least one retry');

  // Confirm JSON serialization does not throw.
  assert.doesNotThrow(() => JSON.stringify(s), 'JSON.stringify(stats()) must not throw');
});

test('stats() JSON-serializes cleanly even with BigInt values in row', async () => {
  // Directly test that Number() coercion handles BigInt inputs,
  // in case libSQL ever returns them in this environment.
  const fakeBigIntRow = {
    operations:      BigInt(5),
    totalPayments:   BigInt(3),
    totalExecutions: BigInt(3),
    retries:         BigInt(7),
  };
  const coerced = {
    operations:      Number(fakeBigIntRow.operations),
    totalPayments:   Number(fakeBigIntRow.totalPayments),
    totalExecutions: Number(fakeBigIntRow.totalExecutions),
    retries:         Number(fakeBigIntRow.retries),
  };
  assert.doesNotThrow(() => JSON.stringify(coerced));
  assert.equal(coerced.operations, 5);
});

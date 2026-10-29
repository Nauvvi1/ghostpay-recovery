/**
 * Tests for the handler.js arcConfigured vs mainnetReady split.
 *
 * Key behaviour verified:
 * - /api/arc/prepare returns 503 when NO contract+merchant are set (regardless of mode)
 * - /api/arc/prepare returns 201 when contract+merchant are set, even if PAYMENT_MODE=demo
 * - /api/arc/recover returns 503 when contract+merchant missing
 * - PAYMENT_MODE=arc is NOT required for arc/prepare or arc/recover
 * - /api/config still reports arcReady:false when PAYMENT_MODE=demo (keeps Failure Lab correct)
 *
 * Uses the in-memory SQLite repository (no Turso creds needed).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ── Minimal request / response stubs ─────────────────────────────────────────

function makeReq(method, path, body = {}) {
  const req = {
    method,
    url: `http://localhost${path}`,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body,  // Vercel pre-parses JSON bodies
    on: () => {},
  };
  return req;
}

function makeRes() {
  const res = {
    _status: 200, _body: null, _headers: {},
    status(s) { this._status = s; return this; },
    json(b)   { this._body  = b; return this; },
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; return this; },
    end()     { return this; },
  };
  return res;
}

// ── In-memory SQLite repository ───────────────────────────────────────────────

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

function makeRepo() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE operations (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'demo',
      status TEXT NOT NULL DEFAULT 'created',
      payer TEXT,
      merchant TEXT,
      amount INTEGER,
      request_hash TEXT,
      result TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      payment_count INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  return {
    async create({ mode, payer, merchant, amount }) {
      const id = '0x' + crypto.randomBytes(32).toString('hex');
      const rh = '0x' + crypto.randomBytes(32).toString('hex');
      db.prepare(
        'INSERT INTO operations (id, mode, payer, merchant, amount, request_hash) VALUES (?,?,?,?,?,?)'
      ).run(id, mode, payer || null, merchant || null, amount || 0, rh);
      return { id };
    },
    async state(id) {
      const row = db.prepare('SELECT * FROM operations WHERE id=?').get(id);
      if (!row) return null;
      return {
        operationId: row.id,
        mode: row.mode,
        status: row.status,
        payer: row.payer,
        merchant: row.merchant,
        amount: row.amount,
        requestHash: row.request_hash,
        paymentCount: row.payment_count,
        attempts: row.attempts,
      };
    },
    async get(id)      { return db.prepare('SELECT * FROM operations WHERE id=?').get(id); },
    async attempt(id)  { db.prepare('UPDATE operations SET attempts=attempts+1 WHERE id=?').run(id); return this.get(id); },
    async stats()      { return { operations: 0, totalPayments: 0, totalExecutions: 0, retries: 0 }; },
    async checkRateLimit() { return { allowed: true }; },
    async payDemo()    {},
    async doJob()      {},
    async finalize()   {},
    async markFault()  { return false; },
    async confirmArc() {},
  };
}

// ── Import handler ────────────────────────────────────────────────────────────

import { handleRequest } from '../api/lib/handler.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

test('/api/arc/prepare returns 503 when ARC_CONTRACT_ADDRESS not set', async () => {
  const saved = { c: process.env.ARC_CONTRACT_ADDRESS, m: process.env.MERCHANT_ADDRESS, p: process.env.PAYMENT_MODE };
  delete process.env.ARC_CONTRACT_ADDRESS;
  delete process.env.MERCHANT_ADDRESS;
  delete process.env.PAYMENT_MODE;
  const repo = makeRepo();
  const req  = makeReq('POST', '/api/arc/prepare', { payer: '0x' + 'a'.repeat(40) });
  const res  = makeRes();
  await handleRequest(req, res, repo);
  assert.equal(res._status, 503, 'should be 503 without contract address');
  assert.ok(res._body.error.includes('ARC_CONTRACT_ADDRESS'), 'error should mention ARC_CONTRACT_ADDRESS');
  process.env.ARC_CONTRACT_ADDRESS = saved.c || '';
  process.env.MERCHANT_ADDRESS     = saved.m || '';
  if (saved.p) process.env.PAYMENT_MODE = saved.p;
});

test('/api/arc/prepare returns 201 when contract+merchant set, even if PAYMENT_MODE=demo', async () => {
  const saved = { c: process.env.ARC_CONTRACT_ADDRESS, m: process.env.MERCHANT_ADDRESS, p: process.env.PAYMENT_MODE };
  // Set contract + merchant but keep mode=demo (or unset)
  process.env.ARC_CONTRACT_ADDRESS = '0xa651aaCB6Bb20263ec5Ac8df243adda01a1CF9e6';
  process.env.MERCHANT_ADDRESS     = '0x6799A524E4599F9cde774e35AbBf7eDE186aB665';
  process.env.PAYMENT_MODE         = 'demo';
  const repo = makeRepo();
  const req  = makeReq('POST', '/api/arc/prepare', { payer: '0x' + 'b'.repeat(40) });
  const res  = makeRes();
  await handleRequest(req, res, repo);
  assert.equal(res._status, 201, `expected 201 but got ${res._status}: ${JSON.stringify(res._body)}`);
  assert.ok(res._body.operationId?.startsWith('0x'), 'response should have operationId');
  assert.equal(res._body.mode, 'arc', 'operation mode should be arc');
  // Restore
  process.env.ARC_CONTRACT_ADDRESS = saved.c || '';
  process.env.MERCHANT_ADDRESS     = saved.m || '';
  if (saved.p) process.env.PAYMENT_MODE = saved.p; else delete process.env.PAYMENT_MODE;
});

test('/api/arc/prepare returns 201 when PAYMENT_MODE=arc (standard arc mode)', async () => {
  const saved = { c: process.env.ARC_CONTRACT_ADDRESS, m: process.env.MERCHANT_ADDRESS, p: process.env.PAYMENT_MODE };
  process.env.ARC_CONTRACT_ADDRESS = '0xa651aaCB6Bb20263ec5Ac8df243adda01a1CF9e6';
  process.env.MERCHANT_ADDRESS     = '0x6799A524E4599F9cde774e35AbBf7eDE186aB665';
  process.env.PAYMENT_MODE         = 'arc';
  const repo = makeRepo();
  const req  = makeReq('POST', '/api/arc/prepare', { payer: '0x' + 'c'.repeat(40) });
  const res  = makeRes();
  await handleRequest(req, res, repo);
  assert.equal(res._status, 201, `expected 201 but got ${res._status}: ${JSON.stringify(res._body)}`);
  process.env.ARC_CONTRACT_ADDRESS = saved.c || '';
  process.env.MERCHANT_ADDRESS     = saved.m || '';
  if (saved.p) process.env.PAYMENT_MODE = saved.p; else delete process.env.PAYMENT_MODE;
});

test('/api/arc/prepare returns 400 for invalid payer address', async () => {
  const saved = { c: process.env.ARC_CONTRACT_ADDRESS, m: process.env.MERCHANT_ADDRESS, p: process.env.PAYMENT_MODE };
  process.env.ARC_CONTRACT_ADDRESS = '0xa651aaCB6Bb20263ec5Ac8df243adda01a1CF9e6';
  process.env.MERCHANT_ADDRESS     = '0x6799A524E4599F9cde774e35AbBf7eDE186aB665';
  process.env.PAYMENT_MODE         = 'demo';
  const repo = makeRepo();
  const req  = makeReq('POST', '/api/arc/prepare', { payer: 'not-an-address' });
  const res  = makeRes();
  await handleRequest(req, res, repo);
  assert.equal(res._status, 400, 'should reject invalid payer');
  process.env.ARC_CONTRACT_ADDRESS = saved.c || '';
  process.env.MERCHANT_ADDRESS     = saved.m || '';
  if (saved.p) process.env.PAYMENT_MODE = saved.p; else delete process.env.PAYMENT_MODE;
});

test('/api/config reports arcReady:false when PAYMENT_MODE=demo regardless of contract addr', async () => {
  const saved = { c: process.env.ARC_CONTRACT_ADDRESS, m: process.env.MERCHANT_ADDRESS, p: process.env.PAYMENT_MODE };
  process.env.ARC_CONTRACT_ADDRESS = '0xa651aaCB6Bb20263ec5Ac8df243adda01a1CF9e6';
  process.env.MERCHANT_ADDRESS     = '0x6799A524E4599F9cde774e35AbBf7eDE186aB665';
  process.env.PAYMENT_MODE         = 'demo';
  const repo = makeRepo();
  const req  = makeReq('GET', '/api/config');
  const res  = makeRes();
  await handleRequest(req, res, repo);
  assert.equal(res._status, 200);
  assert.equal(res._body.arcReady, false,
    'arcReady must be false in demo mode — Failure Lab must not switch to Arc');
  assert.equal(res._body.mode, 'demo');
  process.env.ARC_CONTRACT_ADDRESS = saved.c || '';
  process.env.MERCHANT_ADDRESS     = saved.m || '';
  if (saved.p) process.env.PAYMENT_MODE = saved.p; else delete process.env.PAYMENT_MODE;
});

test('/api/arc/recover returns 503 when contract not set', async () => {
  const saved = { c: process.env.ARC_CONTRACT_ADDRESS, m: process.env.MERCHANT_ADDRESS };
  delete process.env.ARC_CONTRACT_ADDRESS;
  delete process.env.MERCHANT_ADDRESS;
  const repo = makeRepo();
  const req  = makeReq('POST', '/api/arc/recover', { operationId: '0x' + 'a'.repeat(64) });
  const res  = makeRes();
  await handleRequest(req, res, repo);
  assert.equal(res._status, 503, 'recover should 503 without contract');
  process.env.ARC_CONTRACT_ADDRESS = saved.c || '';
  process.env.MERCHANT_ADDRESS     = saved.m || '';
});

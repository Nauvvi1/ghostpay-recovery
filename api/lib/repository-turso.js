/**
 * GhostPay async repository backed by Turso (libSQL).
 *
 * API contract is identical to apps/server/src/repository.js except every
 * method is async.  Vercel serverless functions share no process state, so
 * every invocation re-uses a module-scoped client (warm) or creates a new one
 * (cold start).  Turso handles concurrent writes via its own serialisation.
 *
 * Transactional safety:
 *   INSERT OR IGNORE + conditional UPDATE guarantees that duplicate concurrent
 *   INSERT attempts on the same operation_id are collapsed — the first writer
 *   wins (idempotent in both cases).
 *
 * The schema is created automatically on first connection (see initSchema).
 */

import { createClient } from '@libsql/client';
import { randomBytes, createHash } from 'node:crypto';

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK(mode IN ('demo','arc')),
    payer TEXT NOT NULL,
    merchant TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'created',
    attempts INTEGER NOT NULL DEFAULT 0,
    failure_used INTEGER NOT NULL DEFAULT 0,
    response_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    operation_id TEXT PRIMARY KEY REFERENCES operations(id),
    rail TEXT NOT NULL,
    tx_hash TEXT,
    paid_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    operation_id TEXT PRIMARY KEY REFERENCES operations(id),
    output_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES operations(id),
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_op ON events(operation_id, event_id)`,
  `CREATE TABLE IF NOT EXISTS rate_limit (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    window_start TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

// arc-studio-allow-onchain-literal — sentinel dummy addresses used only as
// demo-mode placeholders in place of real wallet addresses. Never used in
// on-chain transactions.
const demoPayer    = '0x00000000000000000000000000000000000000d3';
const demoMerchant = '0x00000000000000000000000000000000000000a1';

// ── Client singleton (reused across warm invocations) ─────────────────────────

let _sharedClient = null;

export function openTursoRepository({
  url   = process.env.TURSO_DATABASE_URL,
  token = process.env.TURSO_AUTH_TOKEN,
} = {}) {
  if (!url) throw new Error('TURSO_DATABASE_URL is required');

  // Reuse the module-level client within a warm serverless instance.
  // For :memory: in tests, always create a fresh client.
  let db;
  if (url === ':memory:') {
    db = createClient({ url, authToken: token });
  } else {
    if (!_sharedClient) {
      _sharedClient = createClient({ url, authToken: token });
    }
    db = _sharedClient;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  async function initSchema() {
    await db.batch(
      SCHEMA_STATEMENTS.map(sql => ({ sql, args: [] })),
      'write',
    );
  }

  async function exec(sql, args = []) {
    return db.execute({ sql, args });
  }

  async function _get(id) {
    const rs = await db.execute({
      sql: `SELECT o.*,
              p.rail, p.tx_hash, j.output_json,
              (SELECT COUNT(*) FROM payments p2 WHERE p2.operation_id = o.id) AS payment_count,
              (SELECT COUNT(*) FROM jobs    j2 WHERE j2.operation_id = o.id) AS job_count
            FROM operations o
            LEFT JOIN payments p ON p.operation_id = o.id
            LEFT JOIN jobs    j ON j.operation_id = o.id
            WHERE o.id = ?`,
      args: [id],
    });
    return rs.rows[0] ?? null;
  }

  async function _timeline(id) {
    const rs = await db.execute({
      sql: 'SELECT event_id, kind, detail, created_at FROM events WHERE operation_id = ? ORDER BY event_id',
      args: [id],
    });
    return rs.rows;
  }

  async function _event(id, kind, detail) {
    await exec('INSERT INTO events(operation_id, kind, detail) VALUES(?,?,?)', [id, kind, detail]);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async function create({ mode = 'demo', payer = demoPayer, merchant = demoMerchant, amount = 100000 } = {}) {
    const id = `0x${randomBytes(32).toString('hex')}`;
    const request_hash = `0x${createHash('sha256')
      .update(`ghostpay-v1|report|${id}|${payer.toLowerCase()}|${merchant.toLowerCase()}|${amount}`)
      .digest('hex')}`;

    await db.batch([
      {
        sql: 'INSERT INTO operations(id,mode,payer,merchant,request_hash,amount) VALUES(?,?,?,?,?,?)',
        args: [id, mode, payer.toLowerCase(), merchant.toLowerCase(), request_hash, amount],
      },
      {
        sql: 'INSERT INTO events(operation_id,kind,detail) VALUES(?,?,?)',
        args: [id, 'CREATED', `New ${mode === 'demo' ? 'simulated' : 'Arc'} USDC operation`],
      },
    ], 'write');

    return _get(id);
  }

  async function attempt(id) {
    const row = await _get(id);
    if (!row) return null;
    await db.batch([
      { sql: "UPDATE operations SET attempts=attempts+1, updated_at=datetime('now') WHERE id=?", args: [id] },
      { sql: 'INSERT INTO events(operation_id,kind,detail) VALUES(?,?,?)', args: [id, 'RETRY', 'Client invoked the same operation ID'] },
    ], 'write');
    return _get(id);
  }

  async function payDemo(id) {
    const current = await _get(id);
    if (!current || current.mode !== 'demo') throw new Error('Invalid demo operation');

    // INSERT OR IGNORE is the idempotency gate — a second concurrent call does
    // nothing and returns rowsAffected=0.
    const rs = await exec(
      "INSERT OR IGNORE INTO payments(operation_id, rail) VALUES(?,'simulated')",
      [id],
    );
    const inserted = rs.rowsAffected === 1;

    const followUp = [
      {
        sql: 'INSERT INTO events(operation_id,kind,detail) VALUES(?,?,?)',
        args: [id,
          inserted ? 'PAID' : 'PAYMENT_REPLAY_BLOCKED',
          inserted ? 'SIMULATED settlement: 0.10 USDC (no blockchain transaction)' : 'Existing payment reused, no new debit'],
      },
    ];
    if (current.status === 'created') {
      followUp.push({
        sql: "UPDATE operations SET status='paid', updated_at=datetime('now') WHERE id=?",
        args: [id],
      });
    }
    await db.batch(followUp, 'write');
    return inserted;
  }

  async function confirmArc(id, txHash = null) {
    const current = await _get(id);
    if (!current || current.mode !== 'arc') throw new Error('Invalid Arc operation');

    const rs = await exec(
      "INSERT OR IGNORE INTO payments(operation_id, rail, tx_hash) VALUES(?,'arc',?)",
      [id, txHash],
    );
    const inserted = rs.rowsAffected === 1;

    const followUp = [
      {
        sql: 'INSERT INTO events(operation_id,kind,detail) VALUES(?,?,?)',
        args: [id,
          inserted ? 'CHAIN_VERIFIED' : 'RECOVERY',
          inserted ? 'Payment verified from contract state on Arc' : 'Confirmed pre-existing Arc settlement; no payment requested'],
      },
    ];
    if (current.status === 'created') {
      followUp.push({
        sql: "UPDATE operations SET status='paid', updated_at=datetime('now') WHERE id=?",
        args: [id],
      });
    }
    await db.batch(followUp, 'write');
    return inserted;
  }

  async function markFault(id, kind) {
    const row = await _get(id);
    if (!row || row.failure_used) return false;

    // CAS: only set failure_used=1 if currently 0 — prevents double-fault on
    // concurrent requests.
    const rs = await exec(
      "UPDATE operations SET failure_used=1, updated_at=datetime('now') WHERE id=? AND failure_used=0",
      [id],
    );
    if (rs.rowsAffected === 0) return false;

    await _event(id, 'FAULT_INJECTED', kind);
    return true;
  }

  async function doJob(id) {
    const current = await _get(id);
    if (!current || !Number(current.payment_count)) throw new Error('Service cannot run without payment');

    const score   = parseInt(id.slice(2, 10), 16) % 100;
    const payload = JSON.stringify({
      reportId:  `RPT-${id.slice(2, 10).toUpperCase()}`,
      riskScore:  score,
      confidence: 0.97,
      message:   'Report delivered using the original payment.',
      service:   'GhostPay Risk Snapshot',
    });

    const rs = await exec('INSERT OR IGNORE INTO jobs(operation_id, output_json) VALUES(?,?)', [id, payload]);
    const inserted = rs.rowsAffected === 1;

    await _event(id,
      inserted ? 'SERVICE_EXECUTED' : 'SERVICE_REUSED',
      inserted ? 'Durable one-time service result saved' : 'Previously executed service result reused',
    );

    const fresh = await _get(id);
    return { inserted, output: JSON.parse(fresh.output_json) };
  }

  async function finalize(id) {
    const current = await _get(id);
    if (!current?.output_json) throw new Error('Cannot finalize without durable job result');

    if (!current.response_json) {
      await db.batch([
        {
          sql: "UPDATE operations SET status='fulfilled', response_json=?, updated_at=datetime('now') WHERE id=?",
          args: [current.output_json, id],
        },
        {
          sql: 'INSERT INTO events(operation_id,kind,detail) VALUES(?,?,?)',
          args: [id, 'RECOVERED_RESULT', 'Stable, previously paid result available to the client'],
        },
      ], 'write');
    } else {
      await _event(id, 'REPLAYED_RESULT', 'Returned original paid response');
    }

    return _get(id);
  }

  async function state(id) {
    const row = await _get(id);
    if (!row) return null;
    const events = await _timeline(id);
    return {
      operationId:       row.id,
      mode:              row.mode,
      payer:             row.payer,
      merchant:          row.merchant,
      requestHash:       row.request_hash,
      amountUnits:       Number(row.amount),
      amountUSDC:        (Number(row.amount) / 1e6).toFixed(2),
      status:            row.status,
      attempts:          Number(row.attempts),
      paymentCount:      Number(row.payment_count),
      serviceExecutions: Number(row.job_count),
      hasDurableJob:     Boolean(row.output_json),
      txHash:            row.tx_hash ?? null,
      result:            row.response_json ? JSON.parse(row.response_json) : null,
      events,
    };
  }

  async function stats() {
    const rs = await db.execute({
      sql: `SELECT
              COUNT(*) as operations,
              COALESCE((SELECT COUNT(*) FROM payments), 0) as totalPayments,
              COALESCE((SELECT COUNT(*) FROM jobs),     0) as totalExecutions,
              COALESCE(SUM(CASE WHEN attempts > 1 THEN attempts - 1 ELSE 0 END), 0) as retries
            FROM operations`,
      args: [],
    });
    return rs.rows[0];
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Sliding-window counter stored in Turso. Works across serverless instances.
  // limit: max requests; windowSeconds: window duration.

  async function checkRateLimit(key, { limit = 60, windowSeconds = 60 } = {}) {
    await exec(
      `INSERT INTO rate_limit(key, count, window_start) VALUES(?, 1, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         count = CASE
           WHEN (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', window_start) AS INTEGER)) >= ${Number(windowSeconds)}
           THEN 1
           ELSE count + 1
         END,
         window_start = CASE
           WHEN (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', window_start) AS INTEGER)) >= ${Number(windowSeconds)}
           THEN datetime('now')
           ELSE window_start
         END`,
      [key],
    );

    const rs = await exec('SELECT count FROM rate_limit WHERE key = ?', [key]);
    const count = Number(rs.rows[0]?.count ?? 0);
    return { allowed: count <= limit, count, limit };
  }

  return {
    initSchema,
    create, get: _get, state, stats,
    attempt, payDemo, confirmArc, markFault, doJob, finalize,
    checkRateLimit,
    _db: db,
  };
}

// ── Test helper: in-memory libSQL for unit tests ───────────────────────────────
export function openMemoryRepository() {
  // Force a fresh client for each in-memory test database.
  return openTursoRepository({ url: ':memory:', token: undefined });
}

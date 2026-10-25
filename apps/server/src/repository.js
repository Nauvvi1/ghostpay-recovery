import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const CREATE = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS operations (
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
);
CREATE TABLE IF NOT EXISTS payments (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  rail TEXT NOT NULL,
  tx_hash TEXT,
  paid_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_op ON events(operation_id, event_id);
`;
const demoPayer = '0x00000000000000000000000000000000000000d3';
const demoMerchant = '0x00000000000000000000000000000000000000a1';

export function openRepository(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(CREATE);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function event(id, kind, detail) {
    db.prepare('INSERT INTO events(operation_id, kind, detail) VALUES(?,?,?)').run(id,kind,detail);
  }
  function get(id) {
    return db.prepare(`SELECT o.*, p.rail, p.tx_hash, j.output_json,
      (SELECT COUNT(*) FROM payments p2 WHERE p2.operation_id = o.id) AS payment_count,
      (SELECT COUNT(*) FROM jobs j2 WHERE j2.operation_id = o.id) AS job_count
      FROM operations o LEFT JOIN payments p ON p.operation_id=o.id
      LEFT JOIN jobs j ON j.operation_id=o.id WHERE o.id=?`).get(id);
  }
  function timeline(id) {
    return db.prepare('SELECT event_id,kind,detail,created_at FROM events WHERE operation_id=? ORDER BY event_id').all(id);
  }
  function create({ mode='demo', payer=demoPayer, merchant=demoMerchant, amount=100000 }={}) {
    const id = `0x${randomBytes(32).toString('hex')}`;
    // The request hash commits to the exact, priced service and identity of this operation.
    const request_hash = `0x${createHash('sha256').update(`ghostpay-v1|report|${id}|${payer.toLowerCase()}|${merchant.toLowerCase()}|${amount}`).digest('hex')}`;
    transaction(() => {
      db.prepare('INSERT INTO operations(id,mode,payer,merchant,request_hash,amount) VALUES(?,?,?,?,?,?)').run(id,mode,payer.toLowerCase(),merchant.toLowerCase(),request_hash,amount);
      event(id,'CREATED',`New ${mode === 'demo' ? 'simulated' : 'Arc'} USDC operation`);
    });
    return get(id);
  }
  function attempt(id) {
    return transaction(() => {
      if (!get(id)) return null;
      db.prepare("UPDATE operations SET attempts=attempts+1,updated_at=datetime('now') WHERE id=?").run(id);
      event(id,'RETRY','Client invoked the same operation ID');
      return get(id);
    });
  }
  function payDemo(id) {
    return transaction(() => {
      const current = get(id);
      if (!current || current.mode !== 'demo') throw new Error('Invalid demo operation');
      const inserted = db.prepare("INSERT OR IGNORE INTO payments(operation_id,rail) VALUES(?,'simulated')").run(id).changes === 1;
      if (inserted) event(id,'PAID','SIMULATED settlement: 0.10 USDC (no blockchain transaction)');
      else event(id,'PAYMENT_REPLAY_BLOCKED','Existing payment reused, no new debit');
      if (current.status === 'created') db.prepare("UPDATE operations SET status='paid',updated_at=datetime('now') WHERE id=?").run(id);
      return inserted;
    });
  }
  function confirmArc(id, txHash=null) {
    return transaction(() => {
      const current = get(id);
      if (!current || current.mode !== 'arc') throw new Error('Invalid Arc operation');
      const inserted = db.prepare("INSERT OR IGNORE INTO payments(operation_id,rail,tx_hash) VALUES(?,'arc',?)").run(id,txHash).changes === 1;
      if (inserted) event(id,'CHAIN_VERIFIED','Payment verified from contract state on Arc');
      else event(id,'RECOVERY','Confirmed pre-existing Arc settlement; no payment requested');
      if (current.status === 'created') db.prepare("UPDATE operations SET status='paid',updated_at=datetime('now') WHERE id=?").run(id);
      return inserted;
    });
  }
  function markFault(id, kind) {
    return transaction(() => {
      const row = get(id);
      if (!row || row.failure_used) return false;
      db.prepare("UPDATE operations SET failure_used=1,updated_at=datetime('now') WHERE id=?").run(id);
      event(id,'FAULT_INJECTED',kind);
      return true;
    });
  }
  function doJob(id) {
    return transaction(() => {
      const current = get(id);
      if (!current || !current.payment_count) throw new Error('Service cannot run without payment');
      const score = parseInt(id.slice(2,10),16) % 100;
      const payload = JSON.stringify({ reportId:`RPT-${id.slice(2,10).toUpperCase()}`, riskScore:score, confidence:0.97, message:'Report delivered using the original payment.', service:'GhostPay Risk Snapshot' });
      const inserted = db.prepare('INSERT OR IGNORE INTO jobs(operation_id,output_json) VALUES(?,?)').run(id,payload).changes === 1;
      event(id, inserted ? 'SERVICE_EXECUTED' : 'SERVICE_REUSED', inserted ? 'Durable one-time service result saved' : 'Previously executed service result reused');
      return { inserted, output:JSON.parse(get(id).output_json) };
    });
  }
  function finalize(id) {
    return transaction(() => {
      const current = get(id);
      if (!current?.output_json) throw new Error('Cannot finalize without durable job result');
      if (!current.response_json) {
        db.prepare("UPDATE operations SET status='fulfilled',response_json=?,updated_at=datetime('now') WHERE id=?").run(current.output_json,id);
        event(id,'RECOVERED_RESULT','Stable, previously paid result available to the client');
      } else event(id,'REPLAYED_RESULT','Returned original paid response');
      return get(id);
    });
  }
  function state(id) {
    const row=get(id); if(!row) return null;
    return {
      operationId:row.id, mode:row.mode, payer:row.payer, merchant:row.merchant,
      requestHash:row.request_hash, amountUnits:row.amount, amountUSDC:(row.amount/1e6).toFixed(2),
      status:row.status, attempts:row.attempts, paymentCount:row.payment_count,
      serviceExecutions:row.job_count, hasDurableJob:Boolean(row.output_json),
      txHash:row.tx_hash, result:row.response_json ? JSON.parse(row.response_json) : null,
      events:timeline(id)
    };
  }
  function stats() {
    return db.prepare(`SELECT COUNT(*) as operations,
      COALESCE((SELECT COUNT(*) FROM payments),0) as totalPayments,
      COALESCE((SELECT COUNT(*) FROM jobs),0) as totalExecutions,
      COALESCE(SUM(CASE WHEN attempts>1 THEN attempts-1 ELSE 0 END),0) as retries
      FROM operations`).get();
  }
  return { db, create, get, state, stats, attempt, payDemo, confirmArc, markFault, doJob, finalize, close:()=>db.close() };
}

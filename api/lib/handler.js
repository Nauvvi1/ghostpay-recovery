/**
 * Core GhostPay request handler for Vercel serverless functions.
 *
 * Each api/*.js file creates a repo instance, calls `handleRequest(req, res, repo)`,
 * and exports it as `export default`.
 *
 * This file contains NO Node.js `http` server logic — it works with the
 * Vercel function (req, res) interface which mirrors the Node.js IncomingMessage
 * / ServerResponse shape.
 *
 * CORS policy:
 *   - Same as the original app.js: allowlist-based, not reflected.
 *   - Vercel adds its own deployment domain automatically; we also allow the
 *     Arc Studio preview domain and localhost.
 *   - Set GHOSTPAY_ALLOWED_ORIGIN for a custom production domain.
 */

import { ABI, RpcClient } from './rpc.js';
import {
  getPaymentMode, getContractAddress, getMerchantAddress,
  getChainId, getRpcUrl, USDC_ADDRESS, PRICE_UNITS, isAddress, isBytes32,
} from './config.js';

// ── CORS ──────────────────────────────────────────────────────────────────────

const EXTRA_ORIGIN = process.env.GHOSTPAY_ALLOWED_ORIGIN || '';

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (/^https:\/\/[a-z0-9-]+\.preview\.studio\.arc\.io$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  if (EXTRA_ORIGIN && origin === EXTRA_ORIGIN) return true;
  return false;
}

export function applyCors(req, res) {
  const origin = req.headers['origin'];
  if (isAllowedOrigin(origin)) {
    if (origin) res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('vary', 'Origin');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const NO_CACHE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function json(res, status, body) {
  res.status(status).json(body);
}

export function err(res, status, message) {
  json(res, status, { error: message });
}

async function bodyJson(req) {
  // Vercel already parses JSON bodies; fall back to manual parse if not.
  if (req.body !== undefined && req.body !== null) return req.body;
  return new Promise((resolve, reject) => {
    let total = 0; const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > 8192) reject(Object.assign(new Error('Body too large'), { httpStatus: 413 }));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { httpStatus: 400 })); }
    });
    req.on('error', reject);
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleRequest(req, res, repo) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).setHeader('content-length', '0').end();
  }

  const mode       = getPaymentMode();
  const contract   = getContractAddress();
  const merchant   = getMerchantAddress();
  const chainId    = getChainId();
  const rpcUrl     = getRpcUrl();
  const mainnetReady = mode === 'arc' && isAddress(contract) && isAddress(merchant) && contract.toLowerCase() !== USDC_ADDRESS;

  const path = req.url ? new URL(req.url, 'http://localhost').pathname : '/';

  // ── Rate limiting — 120 req/min per IP across all API routes ─────────────
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const rl = await repo.checkRateLimit(`ip:${ip}`, { limit: 120, windowSeconds: 60 });
  if (!rl.allowed) {
    res.setHeader('retry-after', '60');
    return err(res, 429, 'Rate limit exceeded. Retry after 60s.');
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  if (req.method === 'GET' && path === '/api/config') {
    return json(res, 200, {
      mode, arcReady: mainnetReady, chainId, rpcUrl,
      contractAddress:  mainnetReady ? contract : null,
      merchantAddress:  mainnetReady ? merchant : null,
      usdcAddress:      USDC_ADDRESS,
      amountUnits:      PRICE_UNITS,
      amountUSDC:       '0.10',
      selectors:        ABI,
      // arc-studio-allow-onchain-literal — public Arc explorer URL in API response, not an RPC call.
      explorer:         'https://explorer.arc.io',
      scenarios:        ['normal', 'lost-response', 'crash-after-payment', 'crash-after-job', 'concurrent'],
    });
  }

  if (req.method === 'GET' && path === '/api/health') {
    return json(res, 200, { ok: true, mode });
  }

  if (req.method === 'GET' && path === '/api/stats') {
    return json(res, 200, await repo.stats());
  }

  const stateMatch = path.match(/^\/api\/operations\/(0x[0-9a-fA-F]{64})$/);
  if (req.method === 'GET' && stateMatch) {
    const s = await repo.state(stateMatch[1].toLowerCase());
    return s ? json(res, 200, s) : err(res, 404, 'Operation not found');
  }

  if (req.method === 'POST' && path === '/api/demo/start') {
    if (mode === 'arc') return err(res, 403, 'Demo endpoints disabled in Arc payment mode');
    const row = await repo.create({ mode: 'demo' });
    return json(res, 201, await repo.state(row.id));
  }

  if (req.method === 'POST' && path === '/api/demo/attempt') {
    if (mode === 'arc') return err(res, 403, 'Demo endpoints disabled in Arc payment mode');
    const body = await bodyJson(req);
    const SCENARIOS = new Set(['normal', 'lost-response', 'crash-after-payment', 'crash-after-job', 'concurrent']);
    if (!isBytes32(body.operationId) || !SCENARIOS.has(body.scenario)) {
      return err(res, 400, 'Invalid operationId or scenario');
    }
    const id = body.operationId.toLowerCase();
    const op = await repo.attempt(id);
    if (!op || op.mode !== 'demo') return err(res, 404, 'Demo operation not found');

    await repo.payDemo(id);

    if (body.scenario === 'crash-after-payment') {
      const faulted = await repo.markFault(id, 'Simulated process crash after payment persistence, before service execution');
      if (faulted) {
        const s = await repo.state(id);
        return json(res, 503, { error: 'Simulated worker crash after payment; retry using same operationId', state: s });
      }
    }

    await repo.doJob(id);

    if (body.scenario === 'crash-after-job') {
      const faulted = await repo.markFault(id, 'Simulated process crash after durable service output, before response finalization');
      if (faulted) {
        const s = await repo.state(id);
        return json(res, 503, { error: 'Simulated crash after service completion; retry to recover result', state: s });
      }
    }

    await repo.finalize(id);

    if (body.scenario === 'lost-response') {
      const faulted = await repo.markFault(id, 'Serverless: payment and result committed durably; response aborted to simulate TCP loss');
      if (faulted) {
        // In a Vercel Function we cannot destroy the TCP connection because the
        // platform controls the transport.  We return HTTP 499 (client closed
        // request / connection abort) which the GhostPay SDK treats as a
        // connection error (non-2xx, non-JSON), matching the original TCP-drop
        // behaviour: the client receives a hard failure but the data is safe.
        // On retry the operation is found fully finalized and returns the result.
        return res.status(499).end();
      }
    }

    return json(res, 200, { recovered: true, state: await repo.state(id) });
  }

  if (req.method === 'POST' && path === '/api/arc/prepare') {
    if (!mainnetReady) return err(res, 503, 'Arc mode not configured. Set PAYMENT_MODE=arc, ARC_CONTRACT_ADDRESS and MERCHANT_ADDRESS');
    const body = await bodyJson(req);
    if (!isAddress(body.payer)) return err(res, 400, 'Invalid payer address');
    const row = await repo.create({ mode: 'arc', payer: body.payer, merchant, amount: PRICE_UNITS });
    return json(res, 201, await repo.state(row.id));
  }

  if (req.method === 'POST' && path === '/api/arc/recover') {
    if (!mainnetReady) return err(res, 503, 'Arc mode not configured');
    const body = await bodyJson(req);
    if (!isBytes32(body.operationId)) return err(res, 400, 'Invalid operation ID');
    const id = body.operationId.toLowerCase();
    const row = await repo.get(id);
    if (!row || row.mode !== 'arc') return err(res, 404, 'Arc operation not found');
    await repo.attempt(id);
    const rpc = new RpcClient({ url: rpcUrl, chainId });
    const receipt = await rpc.paymentOf(contract, row.payer, id);
    if (receipt.amount === 0n) {
      return json(res, 409, { error: 'No Arc settlement recorded for this operation yet', state: await repo.state(id) });
    }
    if (
      receipt.amount !== BigInt(row.amount) ||
      receipt.merchant !== row.merchant ||
      receipt.requestHash !== row.request_hash
    ) {
      return err(res, 409, 'Onchain payment exists but does not match committed operation parameters');
    }
    await repo.confirmArc(id);
    await repo.doJob(id);
    await repo.finalize(id);
    return json(res, 200, {
      recovered: true, verifiedOnchain: true,
      blockNumber: receipt.blockNumber.toString(),
      state: await repo.state(id),
    });
  }

  return err(res, 404, 'Route not found');
}

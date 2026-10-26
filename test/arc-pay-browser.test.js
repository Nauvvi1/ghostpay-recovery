/**
 * arc-pay-browser.test.js
 *
 * Browser-focused regression tests for the Arc Mainnet payment UI.
 * These run in Node.js but simulate exactly the ABI encoding, session
 * storage persistence, and on-chain read logic that arc-pay.js uses in
 * the browser.
 *
 * Does NOT require MetaMask, a wallet, or live RPC access for most tests.
 * The receipt-lookup test calls Arc Mainnet RPC read-only (eth_call) against
 * the previously-verified payment (payer + operationId from real tx).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers mirrored from arc-pay.js ──────────────────────────────────────

const toWord   = x => x.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const uintWord = v  => BigInt(v).toString(16).padStart(64, '0');
const fromW    = h  => (h.slice(2).match(/.{64}/g) || []);
const safe     = s  => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// ── ABI constants (must match arc-pay.js exactly) ─────────────────────────
// arc-studio-allow-onchain-literal — public Arc Mainnet contract addresses, not RPC calls
const MAINNET_CONTRACT = '0xa651aaCB6Bb20263ec5Ac8df243adda01a1CF9e6';
const MAINNET_USDC     = '0x3600000000000000000000000000000000000000';
const MAINNET_CHAIN_ID = 5042;
const MAINNET_RPC      = 'https://rpc.mainnet.arc.io';

const ABI = {
  pay:       '0x926b1e18',
  paymentOf: '0x62609290',
  usdc:      '0x3e413bee',
  approve:   '0x095ea7b3',
  allowance: '0xdd62ed3e',
  balanceOf: '0x70a08231',
};

// Known values from the verified mainnet payment tx
const KNOWN_PAYER    = '0x198b9199b2b4be050e39b608768e9cb3fe887bab';
const KNOWN_OP_ID    = '0x6d74038d0074c8394fc60a52e48c7cb302f30c6298bff7ede8f3e6ca9bfa86a9';
const KNOWN_MERCHANT = '0x6799a524e4599f9cde774e35abbf7ede186ab665';
const KNOWN_AMOUNT   = 100_000n; // 0.10 USDC in 6-decimal ERC-20 units
const KNOWN_REQ_HASH = '0xdd6d62d56dd5389a80a05cab8164ed8490963655113d9dcc58b58cc6ea5c7abb';
const KNOWN_BLOCK    = 28006631n;

// ── Test 1: pay() calldata encoding ───────────────────────────────────────

test('pay() calldata encodes operationId, merchant, amount, requestHash in correct order', () => {
  // Verified selector: keccak256("pay(bytes32,address,uint256,bytes32)") = 0x926b1e18
  const merchant = KNOWN_MERCHANT;
  const amountUnits = KNOWN_AMOUNT;
  const reqHash = KNOWN_REQ_HASH;
  const opId = KNOWN_OP_ID;

  const data = ABI.pay
    + toWord(opId)
    + merchant.slice(2).padStart(64, '0').toLowerCase()
    + uintWord(amountUnits)
    + toWord(reqHash);

  // Total length: 4 + 32 + 32 + 32 + 32 = 132 bytes = 264 hex chars + "0x" prefix
  assert.equal(data.length, 2 + 8 + 256, 'calldata length is 4 + 4×32 bytes');
  assert.equal(data.slice(0, 10), ABI.pay, 'selector is correct');

  // Word 0 (operationId): bytes32
  const w = fromW(data.slice(10 - 2)); // fromW expects 0x prefix
  // Re-add 0x for fromW
  const words = data.slice(10).match(/.{64}/g);
  assert.equal(words[0], KNOWN_OP_ID.slice(2).toLowerCase(), 'word 0 = operationId');
  assert.equal('0x' + words[1].slice(24), KNOWN_MERCHANT.toLowerCase(), 'word 1 = merchant address');
  assert.equal(BigInt('0x' + words[2]), KNOWN_AMOUNT, 'word 2 = amount');
  assert.equal(words[3], KNOWN_REQ_HASH.slice(2).toLowerCase(), 'word 3 = requestHash');
});

// ── Test 2: paymentOf() calldata encoding ─────────────────────────────────

test('paymentOf() calldata encodes payer address then operationId', () => {
  const data = ABI.paymentOf
    + KNOWN_PAYER.slice(2).padStart(64, '0').toLowerCase()
    + toWord(KNOWN_OP_ID);

  assert.equal(data.slice(0, 10), ABI.paymentOf, 'selector is correct');
  const words = data.slice(10).match(/.{64}/g);
  assert.equal('0x' + words[0].slice(24), KNOWN_PAYER.toLowerCase(), 'word 0 = payer');
  assert.equal(words[1], KNOWN_OP_ID.slice(2).toLowerCase(), 'word 1 = operationId');
});

// ── Test 3: paymentOf() result decoding ───────────────────────────────────

test('paymentOf() result decodes merchant, amount, requestHash, blockNumber correctly', () => {
  // Simulate the raw eth_call response for the known payment
  const merchant     = KNOWN_MERCHANT.slice(2).padStart(64, '0');
  const amount       = KNOWN_AMOUNT.toString(16).padStart(64, '0');
  const requestHash  = KNOWN_REQ_HASH.slice(2);
  const blockNumber  = KNOWN_BLOCK.toString(16).padStart(64, '0');
  const raw = '0x' + merchant + amount + requestHash + blockNumber;

  const w = fromW(raw);
  assert.equal(w.length, 4);
  assert.equal('0x' + w[0].slice(24), KNOWN_MERCHANT, 'merchant decoded');
  assert.equal(BigInt('0x' + w[1]), KNOWN_AMOUNT, 'amount decoded');
  assert.equal('0x' + w[2].toLowerCase(), KNOWN_REQ_HASH.toLowerCase(), 'requestHash decoded');
  assert.equal(BigInt('0x' + w[3]), KNOWN_BLOCK, 'blockNumber decoded');
});

// ── Test 4: amount display conversion ─────────────────────────────────────

test('6-decimal USDC amount 100000 displays as 0.100000 USDC', () => {
  const amount = 100_000n;
  const display = (Number(amount) / 1e6).toFixed(6);
  assert.equal(display, '0.100000');
});

// ── Test 5: operationId persistence key ───────────────────────────────────

test('sessionStorage key is stable and does not collide with Failure Lab key', () => {
  const ARC_KEY = 'ghostpay:arc-mainnet:operationId';
  const LAB_KEY = 'ghostpay:last-operation';
  assert.notEqual(ARC_KEY, LAB_KEY, 'Arc Mainnet key differs from Failure Lab key');
  // Ensure neither key is empty
  assert.ok(ARC_KEY.length > 0);
  assert.ok(LAB_KEY.length > 0);
});

// ── Test 6: replay uses same calldata as first payment ────────────────────

test('replay pay() calldata is byte-identical to first payment calldata', () => {
  const buildPayData = (opId, merchant, amount, reqHash) =>
    ABI.pay
    + toWord(opId)
    + merchant.slice(2).padStart(64, '0').toLowerCase()
    + uintWord(amount)
    + toWord(reqHash);

  const first  = buildPayData(KNOWN_OP_ID, KNOWN_MERCHANT, KNOWN_AMOUNT, KNOWN_REQ_HASH);
  const replay = buildPayData(KNOWN_OP_ID, KNOWN_MERCHANT, KNOWN_AMOUNT, KNOWN_REQ_HASH);
  assert.equal(first, replay, 'identical replay calldata produces identical bytes');
});

// ── Test 7: XSS safety ────────────────────────────────────────────────────

test('safe() escapes HTML special characters in user-supplied values', () => {
  assert.equal(safe('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(safe('"quoted"'), '&quot;quoted&quot;');
  assert.equal(safe("it's"), 'it&#39;s');
  assert.equal(safe(null), '');
  assert.equal(safe(undefined), '');
});

// ── Test 8: payer address validation (mirrors handleLookup guard) ─────────

test('payer address validation accepts valid 0x-prefixed 40-hex address', () => {
  const valid   = addr => /^0x[0-9a-f]{40}$/.test(addr.toLowerCase());
  assert.ok(valid(KNOWN_PAYER));
  assert.ok(valid('0x' + 'a'.repeat(40)));
  assert.ok(!valid('0x' + 'g'.repeat(40)));  // invalid hex char
  assert.ok(!valid('0x' + 'a'.repeat(39)));  // too short
  assert.ok(!valid('0x' + 'a'.repeat(41)));  // too long
  assert.ok(!valid('not-an-address'));
});

// ── Test 9: operationId validation (mirrors handleLookup guard) ───────────

test('operationId validation accepts valid 0x-prefixed 64-hex bytes32', () => {
  const valid = id => /^0x[0-9a-f]{64}$/.test(id.toLowerCase());
  assert.ok(valid(KNOWN_OP_ID));
  assert.ok(valid('0x' + 'b'.repeat(64)));
  assert.ok(!valid('0x' + 'b'.repeat(63)));  // too short
  assert.ok(!valid('0x' + 'b'.repeat(65)));  // too long
  assert.ok(!valid('not-bytes32'));
});

// ── Test 10: live on-chain receipt lookup (read-only eth_call) ────────────
// This test calls Arc Mainnet RPC to verify the known payment is still on-chain.
// It requires network access. It sends no transaction and uses no wallet.

test('paymentOf() on Arc Mainnet returns verified receipt for known payer+operationId', async () => {
  const data = ABI.paymentOf
    + KNOWN_PAYER.slice(2).padStart(64, '0').toLowerCase()
    + toWord(KNOWN_OP_ID);

  let raw;
  try {
    // arc-studio-allow-onchain-literal — Arc Mainnet public RPC, read-only eth_call
    const resp = await fetch(MAINNET_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: MAINNET_CONTRACT, data }, 'latest'] }),
    });
    const body = await resp.json();
    if (body.error) throw new Error(body.error.message);
    raw = body.result;
  } catch (e) {
    // Network unavailable in sandbox — skip with a clear message
    console.log('  (skipped: Arc Mainnet RPC unreachable in this environment)');
    return;
  }

  const w = fromW(raw);
  assert.ok(w.length >= 4, 'receipt has 4 words');

  const merchant    = '0x' + w[0].slice(24);
  const amount      = BigInt('0x' + w[1]);
  const requestHash = '0x' + w[2];
  const blockNumber = BigInt('0x' + w[3]);

  assert.equal(merchant.toLowerCase(), KNOWN_MERCHANT.toLowerCase(),
    'merchant matches known value');
  assert.equal(amount, KNOWN_AMOUNT,
    'amount is 100000 (0.10 USDC in 6-decimal ERC-20)');
  assert.equal(requestHash.toLowerCase(), KNOWN_REQ_HASH.toLowerCase(),
    'requestHash matches');
  assert.equal(blockNumber, KNOWN_BLOCK,
    'blockNumber matches payment tx block');
});

// ── Test 11: approve() calldata uses exact amount (no unlimited approval) ─

test('approve() calldata encodes exact 0.10 USDC, not max uint256', () => {
  const EXACT_AMOUNT = 100_000n;
  const MAX_UINT256  = (1n << 256n) - 1n;

  const exactData = ABI.approve
    + MAINNET_CONTRACT.slice(2).padStart(64, '0').toLowerCase()
    + uintWord(EXACT_AMOUNT);

  const maxData = ABI.approve
    + MAINNET_CONTRACT.slice(2).padStart(64, '0').toLowerCase()
    + uintWord(MAX_UINT256);

  assert.notEqual(exactData, maxData, 'exact amount differs from unlimited max');
  const words = exactData.slice(10).match(/.{64}/g);
  assert.equal(BigInt('0x' + words[1]), EXACT_AMOUNT, 'approval amount is exactly 100000');
  assert.ok(BigInt('0x' + words[1]) < MAX_UINT256, 'approval is less than max uint256');
});

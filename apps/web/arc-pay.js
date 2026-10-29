/**
 * GhostPay Arc Mainnet payment UI.
 *
 * Uses the existing GhostPayClient from /sdk/ghostpay.js for all onchain
 * interactions. Keeps operationId in sessionStorage so it survives page
 * reloads and can be retried without paying again.
 *
 * Contract: 0xa651aaCB6Bb20263ec5Ac8df243adda01a1CF9e6 (Arc Mainnet)
 * Interface (verified from on-chain tx data):
 *   pay(bytes32 operationId, address merchant, uint256 amount, bytes32 requestHash) → selector 0x926b1e18
 *   paymentOf(address payer, bytes32 operationId) → selector 0x62609290
 *   usdc() → selector 0x3e413bee
 *
 * SECURITY: No private keys, seed phrases, or server-side signing.
 *           All transactions require explicit MetaMask approval.
 *           operationId is fixed for the life of an operation — it is never
 *           regenerated on retry, preventing double payment.
 */

import { GhostPayClient } from '/sdk/ghostpay.js';

// ── Constants ─────────────────────────────────────────────────────────────
// arc-studio-allow-onchain-literal — Arc Mainnet public contract addresses
const MAINNET_CHAIN_ID     = 5042;
const MAINNET_CONTRACT     = '0xa651aaCB6Bb20263ec5Ac8df243adda01a1CF9e6';
const MAINNET_USDC         = '0x3600000000000000000000000000000000000000';
const MAINNET_RPC          = 'https://rpc.mainnet.arc.io';
const MAINNET_EXPLORER     = 'https://explorer.arc.io';
const STORAGE_KEY_OP       = 'ghostpay:arc-mainnet:operationId';
const STORAGE_KEY_TXS      = 'ghostpay:arc-mainnet:txHashes';

// ABI selectors — derived from on-chain verification of deployed contract
const ABI = {
  // pay(bytes32 operationId, address merchant, uint256 amount, bytes32 requestHash) = 0x926b1e18
  // Verified: matches deployed tx 0xeea582b5...
  pay:           '0x926b1e18',
  // paymentOf(address payer, bytes32 operationId) = 0x62609290
  // Verified: returns receipt with amount=100000 for payer+opId from real payment
  paymentOf:     '0x62609290',
  // usdc() = 0x3e413bee — returns 0x3600000000000000000000000000000000000000 ✓
  usdc:          '0x3e413bee',
  // Standard ERC-20
  approve:       '0x095ea7b3',  // approve(address,uint256)
  allowance:     '0xdd62ed3e',  // allowance(address,address)
  balanceOf:     '0x70a08231',  // balanceOf(address)
};

// Build /api/config-compatible object for the SDK using hardcoded mainnet values.
// The SDK's submitArcPayment reads: arcReady, chainId, rpcUrl, chainName,
// contractAddress, merchantAddress, usdcAddress, amountUnits, selectors, explorer.
// We build this from the known mainnet constants.
let MAINNET_CONFIG = null;

// ── DOM helpers ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const safe = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shortHash = h => h?.length > 20 ? `${h.slice(0,10)}…${h.slice(-8)}` : (h || '');
const shortAddr = a => a?.length > 16 ? `${a.slice(0,8)}…${a.slice(-6)}` : (a || '');

let client = null;
let wallet = null;
let activeOp = null;
let busy = false;
let txHashes = [];   // [{type, hash}] accumulated this session

function setStatus(msg, kind = '') {
  const el = $('statusLine');
  el.textContent = msg;
  el.className = 'status-line' + (kind ? ` ${kind}` : '');
}

function setStep(name) {
  // Steps: connect, prepare, approve, pay, recover
  const order = ['connect', 'prepare', 'approve', 'pay', 'recover'];
  const idx = order.indexOf(name);
  order.forEach((step, i) => {
    const el = $('step' + step.charAt(0).toUpperCase() + step.slice(1));
    if (!el) return;
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', i < idx);
  });
}

function setBusy(val) {
  busy = val;
  $('btnConnect').disabled  = val || !!wallet;
  $('btnPrepare').disabled  = val || !wallet;
  $('btnPay').disabled      = val || !activeOp || !!activeOp.paid;
  $('btnReplay').disabled   = val || !activeOp || !activeOp.paid;
  $('btnRecover').disabled  = val || !activeOp;
}

function addEvent(kind, detail, category = 'info') {
  const now = new Date().toISOString().slice(11, 23);
  const list = $('eventList');
  // Remove "No events yet" placeholder
  const empty = list.querySelector('.empty-events');
  if (empty) empty.remove();
  const cls = category === 'good' ? 'ev-good' : category === 'bad' ? 'ev-bad' : 'ev-info';
  const div = document.createElement('div');
  div.className = `event-item ${cls}`;
  div.innerHTML =
    `<span class="event-time">${safe(now)}</span>` +
    `<span class="event-kind">${safe(kind.replaceAll('_', ' '))}</span>` +
    `<span class="event-detail">${safe(detail)}</span>`;
  list.prepend(div);
  const count = list.querySelectorAll('.event-item').length;
  $('eventCount').textContent = `${count} EVENT${count === 1 ? '' : 'S'}`;
}

function addTxLink(type, hash) {
  txHashes = [...txHashes.filter(t => t.type !== type), {type, hash}];
  persistTxHashes();
  renderTxLinks();
}

function renderTxLinks() {
  if (!txHashes.length) { $('txLinks').hidden = true; return; }
  $('txLinks').hidden = false;
  const tagClass = { payment: 'tag-payment', replay: 'tag-replay', approve: 'tag-approve' };
  $('txLinkList').innerHTML = txHashes.map(({type, hash}) =>
    `<div class="tx-link-item">
      <span class="tx-link-tag ${tagClass[type] || 'tag-approve'}">${safe(type.toUpperCase())}</span>
      <a href="${safe(MAINNET_EXPLORER)}/tx/${safe(hash)}" target="_blank" rel="noopener noreferrer">${safe(shortHash(hash))} ↗</a>
    </div>`
  ).join('');
}

function persistTxHashes() {
  try { sessionStorage.setItem(STORAGE_KEY_TXS, JSON.stringify(txHashes)); } catch {}
}

function renderOp(op, source = null) {
  activeOp = op;
  const paid = op.paid || op.paymentCount > 0 || op.status === 'fulfilled';
  const replayed = op.replayed;

  $('opId').textContent = shortHash(op.operationId);
  $('opId').title = op.operationId;
  $('opReqHash').textContent = shortHash(op.requestHash || op.request_hash || '—');
  $('btnCopyId').disabled = false;

  const chip = $('opStatusChip');
  if (replayed) {
    chip.textContent = 'REPLAYED';
    chip.className = 'status-chip replayed';
  } else if (paid) {
    chip.textContent = 'PAID';
    chip.className = 'status-chip paid';
  } else {
    chip.textContent = 'CREATED';
    chip.className = 'status-chip';
  }

  $('ledgerPaid').textContent = paid ? (op.amountUSDC || '0.10') : '0.00';
  $('ledgerRetries').textContent = Math.max(0, (op.attempts || 1) - 1);
  $('ledgerDups').textContent = op.paymentCount > 1 ? op.paymentCount - 1 : 0;

  if (source) {
    $('paymentSourceBlock').hidden = false;
    $('paymentSource').innerHTML = source;
  }

  renderTxLinks();
  setBusy(busy);
}

/**
 * Verify an on-chain receipt against the expected operation parameters before
 * treating the payment as confirmed. Throws a descriptive error if any field
 * does not match so the caller can surface it to the user rather than silently
 * accepting a receipt for a different payment.
 *
 * @param {object} receipt  — from readReceipt() {merchant, amount, requestHash, blockNumber}
 * @param {object} expected — {merchant: string, amountUnits: bigint, requestHash: string}
 */
function verifyReceipt(receipt, expected) {
  if (!receipt || receipt.amount === 0n) {
    throw new Error('Receipt has zero amount — operation has not been settled on-chain.');
  }
  if (expected.merchant &&
      receipt.merchant.toLowerCase() !== expected.merchant.toLowerCase()) {
    throw new Error(
      `Receipt merchant ${receipt.merchant} does not match expected ${expected.merchant}. ` +
      'Do not treat this as a valid payment for this operation.'
    );
  }
  if (expected.amountUnits !== undefined &&
      receipt.amount !== BigInt(expected.amountUnits)) {
    throw new Error(
      `Receipt amount ${receipt.amount} units does not match expected ${expected.amountUnits} units.`
    );
  }
  if (expected.requestHash &&
      receipt.requestHash.toLowerCase() !== expected.requestHash.toLowerCase()) {
    throw new Error(
      `Receipt requestHash does not match operation requestHash — ` +
      'this on-chain payment was for different request parameters.'
    );
  }
}

function renderOnchainResult(receipt, isReplay) {
  const label = isReplay ? 'ON-CHAIN REPLAY CONFIRMED' : 'ON-CHAIN PAYMENT CONFIRMED';
  const badge = isReplay
    ? '<span class="replayed-badge">REPLAYED</span>'
    : '<span class="onchain-badge">MAINNET</span>';
  $('outputBox').innerHTML =
    `<div class="result-title">✓ ${safe(label)} ${badge}</div>
    <div class="result-row">Merchant <strong>${safe(shortAddr(receipt.merchant))}</strong></div>
    <div class="result-row">Amount <strong>${safe(Number(receipt.amount) / 1e6)} USDC</strong></div>
    <div class="result-row">Block <strong>${safe(receipt.blockNumber.toString())}</strong></div>
    <div class="result-row">Request hash <strong class="small-mono">${safe(shortHash(receipt.requestHash))}</strong></div>
    <div class="result-row">Extra debits <strong class="mint-num">0</strong></div>`;
}

// ── Low-level helpers ─────────────────────────────────────────────────────

const toWord   = x => x.replace(/^0x/i,'').toLowerCase().padStart(64,'0');
const uintWord = v  => BigInt(v).toString(16).padStart(64,'0');
const fromW    = h  => (h.slice(2).match(/.{64}/g) || []);

async function ethCall(to, data) {
  return client.walletRequest('eth_call', [{to, data}, 'latest']);
}

async function readReceipt(payer, operationId) {
  const data = ABI.paymentOf + payer.slice(2).padStart(64,'0') + toWord(operationId);
  const raw = await ethCall(MAINNET_CONTRACT, data);
  const w = fromW(raw);
  if (w.length < 4) return null;
  return {
    merchant:    '0x' + w[0].slice(24),
    amount:      BigInt('0x' + w[1]),
    requestHash: '0x' + w[2],
    blockNumber: BigInt('0x' + w[3]),
  };
}

async function readUsdc(address) {
  const data = ABI.balanceOf + address.slice(2).padStart(64,'0');
  const raw = await ethCall(MAINNET_USDC, data);
  const w = fromW(raw);
  return w.length ? BigInt('0x' + w[0]) : 0n;
}

async function readAllowance(owner, spender) {
  const data = ABI.allowance + owner.slice(2).padStart(64,'0') + spender.slice(2).padStart(64,'0');
  const raw = await ethCall(MAINNET_USDC, data);
  const w = fromW(raw);
  return w.length ? BigInt('0x' + w[0]) : 0n;
}

async function refreshBalance() {
  if (!wallet) return;
  try {
    const bal = await readUsdc(wallet);
    // USDC ERC-20 has 6 decimals
    const display = (Number(bal) / 1e6).toFixed(6);
    $('usdcBalance').textContent = `${display} USDC (6-decimal ERC-20)`;
  } catch {
    $('usdcBalance').textContent = 'Could not read balance';
  }
}

// ── Step handlers ─────────────────────────────────────────────────────────

async function handleConnect() {
  if (busy || wallet) return;
  setBusy(true);
  setStatus('Requesting wallet access…');
  addEvent('CONNECT', 'Requesting MetaMask account');
  try {
    wallet = await client.connectArc(MAINNET_CONFIG);
    $('walletAddr').textContent = wallet;
    $('walletAddr').title = wallet;
    setStatus('Wallet connected to Arc Mainnet.', 'good');
    addEvent('CONNECTED', shortAddr(wallet), 'good');
    setStep('prepare');
    await refreshBalance();

    // Check for a persisted operation from a previous load
    const savedOpId = sessionStorage.getItem(STORAGE_KEY_OP);
    const savedTxs  = sessionStorage.getItem(STORAGE_KEY_TXS);
    if (savedOpId) {
      try {
        txHashes = savedTxs ? JSON.parse(savedTxs) : [];
        setStatus('Resuming previous operation from session…');
        const op = await client.getOperation(savedOpId);
        renderOp(op, '<span class="source-mainnet">Arc Mainnet · resumed from session</span>');
        addEvent('SESSION_RESUMED', `op ${shortHash(savedOpId)}`, 'info');

        // Check live on-chain state for this operation
        const receipt = await readReceipt(wallet, savedOpId);
        if (receipt && receipt.amount > 0n) {
          const isReplay = txHashes.some(t => t.type === 'replay');
          renderOnchainResult(receipt, isReplay);
          addEvent('CHAIN_VERIFIED', `block ${receipt.blockNumber}`, 'good');
        }
      } catch {
        sessionStorage.removeItem(STORAGE_KEY_OP);
        sessionStorage.removeItem(STORAGE_KEY_TXS);
      }
    }
  } catch (e) {
    setStatus(e.message, 'error');
    addEvent('CONNECT_ERROR', e.message, 'bad');
    wallet = null;
  } finally {
    setBusy(false);
  }
}

async function handlePrepare() {
  if (!wallet || busy) return;
  setBusy(true);
  setStatus('Creating operation on recovery backend…');
  addEvent('PREPARE', 'Creating immutable operation ID');
  try {
    const op = await client.prepareArc(wallet);
    sessionStorage.setItem(STORAGE_KEY_OP, op.operationId);
    sessionStorage.removeItem(STORAGE_KEY_TXS);
    txHashes = [];
    renderOp(op, '<span class="source-mainnet">Arc Mainnet · new operation</span>');
    setStatus('Operation prepared. operationId is fixed — do not generate a new one on retry.', 'good');
    addEvent('OPERATION_CREATED', shortHash(op.operationId), 'good');
    setStep('approve');
  } catch (e) {
    setStatus(e.message, 'error');
    addEvent('PREPARE_ERROR', e.message, 'bad');
  } finally {
    setBusy(false);
  }
}

async function handlePay() {
  if (!activeOp || busy || activeOp.paid) return;
  setBusy(true);
  setStatus('Checking on-chain state before submitting…');
  addEvent('PAY_START', '0.10 USDC · checking chain first');
  try {
    // Critical: check chain state BEFORE sending anything.
    // This prevents double payment if a previous tx was lost but confirmed.
    const existing = await readReceipt(wallet, activeOp.operationId);
    if (existing && existing.amount > 0n) {
      // Verify fields before accepting the existing receipt
      const reqHashEarly = activeOp.requestHash || activeOp.request_hash;
      try {
        verifyReceipt(existing, {
          merchant:    activeOp.merchant || MAINNET_CONFIG.merchantAddress,
          amountUnits: 100_000n,
          ...(reqHashEarly ? { requestHash: reqHashEarly } : {}),
        });
      } catch (verifyErr) {
        throw new Error(`Existing on-chain receipt failed verification: ${verifyErr.message}`);
      }
      setStatus('Payment already recorded on-chain. Using existing receipt.', 'good');
      addEvent('ALREADY_PAID', `block ${existing.blockNumber}`, 'good');
      renderOnchainResult(existing, false);
      activeOp.paid = true;
      setBusy(false);
      return;
    }

    const amountUnits = 100_000n; // 0.10 USDC in 6-decimal ERC-20 units

    // Step 1: check allowance
    const allowance = await readAllowance(wallet, MAINNET_CONTRACT);
    setStatus(`Current allowance: ${Number(allowance)/1e6} USDC. Required: 0.10 USDC.`);
    addEvent('ALLOWANCE_READ', `${Number(allowance)/1e6} USDC`, 'info');

    if (allowance < amountUnits) {
      setStatus('Requesting exact 0.10 USDC approval in MetaMask…');
      addEvent('APPROVE_REQUESTED', 'exact 0.10 USDC');
      const approveTx = await client.walletRequest('eth_sendTransaction', [{
        from: wallet,
        to:   MAINNET_USDC,
        value: '0x0',
        data: ABI.approve + toWord(MAINNET_CONTRACT) + uintWord(amountUnits),
      }]);
      setStatus('Approval submitted. Waiting for confirmation…');
      addEvent('APPROVE_TX', shortHash(approveTx));
      await client.waitReceipt(approveTx);
      addTxLink('approve', approveTx);
      setStatus('Approval confirmed.', 'good');
      addEvent('APPROVED', '0.10 USDC to contract', 'good');
    }

    // Step 2: preflight again before sending pay()
    const existingAfterApproval = await readReceipt(wallet, activeOp.operationId);
    if (existingAfterApproval && existingAfterApproval.amount > 0n) {
      setStatus('Payment settled by another request during approval. No duplicate sent.', 'good');
      addEvent('RACE_AVOIDED', 'payment already on-chain', 'good');
      renderOnchainResult(existingAfterApproval, false);
      activeOp.paid = true;
      setBusy(false);
      return;
    }

    // Step 3: send pay() — operationId, merchant, amount, requestHash
    // Signature: pay(bytes32,address,uint256,bytes32) = 0x926b1e18
    const reqHash = activeOp.requestHash || activeOp.request_hash;
    if (!reqHash) throw new Error('Operation requestHash is missing — prepare a new operation');

    setStatus('Submitting GhostPay.pay() in MetaMask… review and confirm the transaction.');
    addEvent('PAY_TX_REQUESTED', '0.10 USDC · awaiting MetaMask');
    const payTx = await client.walletRequest('eth_sendTransaction', [{
      from:  wallet,
      to:    MAINNET_CONTRACT,
      value: '0x0',
      data:  ABI.pay
        + toWord(activeOp.operationId)                                      // bytes32 operationId
        + (activeOp.merchant || MAINNET_CONFIG.merchantAddress)
            .slice(2).padStart(64,'0').toLowerCase()                         // address merchant
        + uintWord(amountUnits)                                              // uint256 amount
        + toWord(reqHash),                                                   // bytes32 requestHash
    }]);

    setStatus('Payment transaction submitted. Waiting for confirmation…');
    addEvent('PAY_TX_SENT', shortHash(payTx));
    await client.waitReceipt(payTx);
    addTxLink('payment', payTx);
    setStatus('Payment confirmed on Arc Mainnet!', 'good');
    addEvent('PAYMENT_RECORDED', `tx ${shortHash(payTx)} · block confirmed`, 'good');

    // Step 4: read and VERIFY the on-chain receipt before rendering.
    // This catches the (very rare) case where the RPC returns stale data or
    // the contract address was misconfigured.
    const receipt = await readReceipt(wallet, activeOp.operationId);
    verifyReceipt(receipt, {
      merchant:     activeOp.merchant || MAINNET_CONFIG.merchantAddress,
      amountUnits:  100_000n,
      requestHash:  reqHash,
    });

    renderOnchainResult(receipt, false);
    activeOp.paid = true;
    $('paymentSourceBlock').hidden = false;
    $('paymentSource').innerHTML = `<span class="source-mainnet">Arc Mainnet · PaymentRecorded · block ${receipt.blockNumber}</span>`;
    setStep('recover');
    await refreshBalance();

    // Trigger backend recovery to link the on-chain receipt to the durable job record.
    // Failure here does NOT invalidate the payment — the on-chain receipt is the source
    // of truth. The backend records the result for future /api/arc/recover calls.
    try {
      setStatus('Notifying recovery backend…');
      const recovery = await client.recoverArc(activeOp.operationId);
      setStatus('Payment confirmed and backend notified.', 'good');
      addEvent('BACKEND_VERIFIED',
        `Durable job record updated · block ${recovery.blockNumber || receipt.blockNumber}`,
        'good');
    } catch (e) {
      // Backend unavailable (e.g. PAYMENT_MODE=demo, no Turso creds, or transient error).
      // The on-chain payment is still confirmed — the backend will sync on next /api/arc/recover call.
      setStatus('Payment confirmed on-chain. Backend sync pending — use "Recover from Arc" to sync.', 'good');
      addEvent('BACKEND_UNAVAILABLE',
        `Backend did not confirm: ${e.message}. On-chain receipt is the authority.`,
        'info');
    }

  } catch (e) {
    setStatus(`Payment interrupted: ${e.message}. Use "Recover from Arc" — do NOT prepare a new operation.`, 'error');
    addEvent('PAY_ERROR', e.message, 'bad');
  } finally {
    setBusy(false);
  }
}

async function handleReplay() {
  if (!activeOp || !activeOp.paid || busy) return;
  setBusy(true);
  setStatus('Submitting identical replay to demonstrate idempotency…');
  addEvent('REPLAY_START', 'Exact same operationId, merchant, amount, requestHash');
  try {
    const amountUnits = 100_000n;
    const reqHash = activeOp.requestHash || activeOp.request_hash;
    if (!reqHash) throw new Error('Operation requestHash missing');

    // Pre-replay check: already paid → read current allowance (may be 0 after first payment consumed it)
    const allowance = await readAllowance(wallet, MAINNET_CONTRACT);
    addEvent('ALLOWANCE_READ', `${Number(allowance)/1e6} USDC before replay`, 'info');

    // Note: if allowance < amountUnits, we still send — the contract will return false
    // (PaymentReplayed) without calling transferFrom, so it will succeed even with 0 allowance.

    setStatus('Submitting replay pay() in MetaMask… same parameters as the first payment.');
    const replayTx = await client.walletRequest('eth_sendTransaction', [{
      from:  wallet,
      to:    MAINNET_CONTRACT,
      value: '0x0',
      data:  ABI.pay
        + toWord(activeOp.operationId)
        + (activeOp.merchant || MAINNET_CONFIG.merchantAddress)
            .slice(2).padStart(64,'0').toLowerCase()
        + uintWord(amountUnits)
        + toWord(reqHash),
    }]);

    setStatus('Replay transaction submitted. Waiting for confirmation…');
    addEvent('REPLAY_TX_SENT', shortHash(replayTx));
    await client.waitReceipt(replayTx);
    addTxLink('replay', replayTx);
    setStatus('Replay confirmed. PaymentReplayed emitted — zero additional USDC transferred. Gas fee applies.', 'good');
    addEvent('PAYMENT_REPLAYED', `tx ${shortHash(replayTx)} · no USDC transferred · gas fee paid`, 'good');

    // The receipt should still show the original payment amount
    const receipt = await readReceipt(wallet, activeOp.operationId);
    if (receipt && receipt.amount > 0n) {
      renderOnchainResult(receipt, true);
      $('paymentSource').innerHTML = `<span class="source-replay">Arc Mainnet · PaymentReplayed · no additional debit</span>`;
      $('ledgerDups').textContent = '0';  // still 0 extra debits — contract protected it
    }

    await refreshBalance();
  } catch (e) {
    setStatus(`Replay error: ${e.message}`, 'error');
    addEvent('REPLAY_ERROR', e.message, 'bad');
  } finally {
    setBusy(false);
  }
}

async function handleRecover() {
  if (!activeOp || busy) return;
  setBusy(true);
  setStatus('Querying Arc Mainnet for payment receipt…');
  addEvent('RECOVER_START', 'Reading chain state without new tx');
  try {
    // Read on-chain receipt — do NOT trust any browser-local state
    const receipt = await readReceipt(wallet, activeOp.operationId);
    if (!receipt || receipt.amount === 0n) {
      setStatus('No on-chain payment found for this operation yet.', 'error');
      addEvent('RECOVER_EMPTY', 'No settlement on chain', 'bad');
      setBusy(false);
      return;
    }

    // Verify receipt fields match the active operation before rendering.
    const reqHash = activeOp?.requestHash || activeOp?.request_hash;
    verifyReceipt(receipt, {
      merchant:    activeOp?.merchant || MAINNET_CONFIG.merchantAddress,
      amountUnits: 100_000n,
      ...(reqHash ? { requestHash: reqHash } : {}),
    });

    const isReplay = txHashes.some(t => t.type === 'replay');
    renderOnchainResult(receipt, isReplay);
    setStatus('On-chain receipt verified. Original result recovered.', 'good');
    addEvent('CHAIN_VERIFIED', `block ${receipt.blockNumber} · amount ${Number(receipt.amount)/1e6} USDC`, 'good');

    // Attempt backend sync — this writes the on-chain result into the durable job store
    // so subsequent /api/operations/:id calls reflect the settled state.
    // If the backend is unavailable the on-chain receipt is still authoritative.
    try {
      await client.recoverArc(activeOp.operationId);
      addEvent('BACKEND_VERIFIED', 'Durable job record synced with on-chain receipt', 'good');
    } catch (e) {
      addEvent('BACKEND_UNAVAILABLE',
        `Backend sync failed: ${e.message}. On-chain receipt is the authority — payment is confirmed.`,
        'info');
    }
  } catch (e) {
    setStatus(`Recovery error: ${e.message}`, 'error');
    addEvent('RECOVER_ERROR', e.message, 'bad');
  } finally {
    setBusy(false);
  }
}

// ── Read-only receipt lookup (no wallet required) ─────────────────────────

async function rpcCall(method, params) {
  // arc-studio-allow-onchain-literal — direct read from Arc Mainnet public RPC, no signing
  const resp = await fetch(MAINNET_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await resp.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

async function handleLookup() {
  const payer    = $('lookupPayer').value.trim().toLowerCase();
  const opId     = $('lookupOpId').value.trim().toLowerCase();
  const result   = $('lookupResult');
  const inner    = $('lookupResultInner');
  const btn      = $('btnLookup');

  // Validate inputs
  if (!/^0x[0-9a-f]{40}$/.test(payer)) {
    inner.innerHTML = '<div class="lookup-error">Invalid payer address. Must be 0x followed by 40 hex chars.</div>';
    result.hidden = false; return;
  }
  if (!/^0x[0-9a-f]{64}$/.test(opId)) {
    inner.innerHTML = '<div class="lookup-error">Invalid operation ID. Must be 0x followed by 64 hex chars.</div>';
    result.hidden = false; return;
  }

  btn.disabled = true;
  inner.innerHTML = '<div class="output-placeholder">⟳ Querying Arc Mainnet…</div>';
  result.hidden = false;

  try {
    // paymentOf(address payer, bytes32 operationId) — selector 0x62609290
    const data = ABI.paymentOf
      + payer.slice(2).padStart(64, '0')
      + opId.slice(2);

    const raw = await rpcCall('eth_call', [{ to: MAINNET_CONTRACT, data }, 'latest']);
    const w = fromW(raw);

    if (w.length < 4 || BigInt('0x' + w[1]) === 0n) {
      inner.innerHTML = `<div class="lookup-error">No payment receipt found for this payer + operationId combination on Arc Mainnet.</div>`;
      return;
    }

    const merchant     = '0x' + w[0].slice(24);
    const amount       = BigInt('0x' + w[1]);
    const requestHash  = '0x' + w[2];
    const blockNumber  = BigInt('0x' + w[3]);
    const amountUsdc   = (Number(amount) / 1e6).toFixed(6);

    inner.innerHTML =
      `<div class="result-title">✓ ON-CHAIN RECEIPT FOUND <span class="onchain-badge">MAINNET</span></div>
      <div class="result-row">Payer      <strong class="small-mono">${safe(payer)}</strong></div>
      <div class="result-row">Operation  <strong class="small-mono">${safe(shortHash(opId))}</strong></div>
      <div class="result-row">Merchant   <strong class="small-mono">${safe(merchant)}</strong></div>
      <div class="result-row">Amount     <strong>${safe(amountUsdc)} USDC (${safe(amount.toString())} units, 6-decimal ERC-20)</strong></div>
      <div class="result-row">Block      <strong>${safe(blockNumber.toString())}</strong></div>
      <div class="result-row">Request hash <strong class="small-mono">${safe(shortHash(requestHash))}</strong></div>
      <div class="result-row" style="margin-top:12px;">
        <a class="vs-link" href="${safe(MAINNET_EXPLORER)}/address/${safe(MAINNET_CONTRACT)}" target="_blank" rel="noopener noreferrer">View contract on Arc Explorer ↗</a>
      </div>`;
  } catch (e) {
    inner.innerHTML = `<div class="lookup-error">RPC error: ${safe(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  // Fetch /api/config so GhostPayClient uses the correct baseUrl and backend config.
  // We always override chainId/contract/explorer with hardcoded mainnet values since
  // the public Vercel instance runs in demo mode (correct — we don't change it).
  const apiClient = new GhostPayClient();
  let serverConfig = null;
  try {
    serverConfig = await apiClient.getConfig();
  } catch {
    // Backend unavailable — still usable for on-chain reads, not for recovery backend
    serverConfig = { mode: 'demo', arcReady: false };
  }

  // Build the mainnet config the SDK needs for chain-switching
  MAINNET_CONFIG = {
    arcReady:        true,
    chainId:         MAINNET_CHAIN_ID,
    chainName:       'Arc Mainnet',
    rpcUrl:          MAINNET_RPC,
    explorer:        MAINNET_EXPLORER,
    contractAddress: MAINNET_CONTRACT,
    merchantAddress: serverConfig.merchantAddress || '0x6799A524E4599F9cde774e35AbBf7eDE186aB665',
    usdcAddress:     MAINNET_USDC,
    amountUnits:     100_000,
    amountUSDC:      '0.10',
    selectors:       {
      pay:       ABI.pay,
      paymentOf: ABI.paymentOf,
      approve:   ABI.approve,
      allowance: ABI.allowance,
      balanceOf: ABI.balanceOf,
      usdc:      ABI.usdc,
    },
  };

  // The client used for /api/* calls uses the same server origin (relative URLs)
  // The ethereum provider is picked up from window.ethereum by GhostPayClient
  client = new GhostPayClient({ ethereum: globalThis.ethereum });

  // Wire buttons
  $('btnConnect').addEventListener('click', handleConnect);
  $('btnPrepare').addEventListener('click', handlePrepare);
  $('btnPay').addEventListener('click', handlePay);
  $('btnReplay').addEventListener('click', handleReplay);
  $('btnRecover').addEventListener('click', handleRecover);
  $('btnLookup').addEventListener('click', handleLookup);
  $('btnCopyId').addEventListener('click', async () => {
    if (!activeOp) return;
    try {
      await navigator.clipboard.writeText(activeOp.operationId);
      setStatus('Operation ID copied to clipboard.', 'good');
    } catch {
      setStatus('Clipboard unavailable. See hover title on the ID field.');
    }
  });

  setBusy(false);
  setStep('connect');

  if (!globalThis.ethereum) {
    setStatus('No EIP-1193 wallet detected. Install MetaMask to use Arc Mainnet payments.', 'error');
    $('btnConnect').disabled = true;
    addEvent('NO_WALLET', 'MetaMask not detected', 'bad');
  }
}


boot().catch(e => console.error('[arc-pay]', e));

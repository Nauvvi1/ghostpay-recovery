# GhostPay — Arc Studio Development Report

Built with [Arc Studio](https://studio.arc.io)

---

## 1. Contract verification

**Contract:** `0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874`  
**Network:** Arc Testnet (chain ID `5042002`)  
**Deploy tx:** `0x04dbccf3e389401a9fb946f54a9490d55f5b32bea0291074c0b4c202bbba9e62`  
**Explorer:** https://explorer.testnet.arc.io/address/0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874

Verified live via `eth_call`:

| Check | Result |
|---|---|
| `GhostPay.usdc()` | `0x3600000000000000000000000000000000000000` ✓ |
| Contract is deployed | Yes (bytecode confirmed) ✓ |
| USDC address matches Arc Testnet canonical | Yes ✓ |
| Arc Testnet chain ID | `5042002` |

The contract constructor was passed `0x3600000000000000000000000000000000000000` (the Arc USDC
predeploy, same address on testnet and mainnet). `usdc()` returning that address confirms the
constructor argument was accepted and stored.

The contract source is NOT verified on the Arc Testnet explorer at this time (the explorer's
Blockscout API did not return a verified result). Source verification steps are in
section 6 below.

---

## 2. Solidity test results — `forge test -vv`

All 6 tests pass after renaming the deprecated `testFail*` function.

| Test | Gas | Result |
|---|---|---|
| `testFirstPaymentAndReplayOnlyChargesOnce` | 155 937 | PASS |
| `testChangedMerchantRevertsWithoutExtraPayment` | 170 607 | PASS |
| `testChangedAmountOrHashReverts` | 190 916 | PASS |
| `testDifferentPayersHaveIsolatedOperationKeys` | 261 697 | PASS |
| `test_RevertWhen_TransferFailsNoReceiptRecorded` | 142 646 | PASS |
| `testSeparateOperationsBothSettle` | 245 292 | PASS |

**Coverage of GhostPay.pay() invariants tested:**

- First payment settles and merchant receives USDC: ✓
- Identical replay returns `false`, no second transfer: ✓
- Replay with different merchant reverts (`DifferentReplayParameters`): ✓
- Replay with different amount reverts: ✓
- Replay with different request hash reverts: ✓
- Failed `transferFrom` (insufficient allowance) reverts atomically, no receipt recorded: ✓
- Two different payers, same operation ID, are isolated (separate receipt keys): ✓
- Two different operation IDs from same payer both settle independently: ✓

---

## 3. JavaScript integration test results — `node --test test/engine.test.js`

12/12 pass.

| Test | Result |
|---|---|
| Keccak-256 vectors and function selectors | PASS |
| ABI encoder/decoder, 6-decimal USDC | PASS |
| Lost response: TCP closed, no double debit on retry | PASS |
| Crash after payment: work recovered in new request | PASS |
| Crash after job: durable output restored, service not re-run | PASS |
| Five concurrent requests: exactly one payment, one service exec | PASS |
| SQLite persistence across repository re-open | PASS |
| Arc backend: onchain receipt check, mismatch rejection | PASS |
| HTTP validation: invalid scenario and bad operation ID | PASS |
| RPC client: chain ID verification, USDC token check, receipt decode | PASS |
| EIP-1193 SDK: skips send when operation already settled onchain | PASS |
| EIP-1193 SDK: exact allowance + one payment for new operation | PASS |

---

## 4. Failure Lab — live backend verification

All four interactive scenarios verified via direct HTTP against the running server:

| Scenario | Observed behaviour | Correct |
|---|---|---|
| `lost-response` | TCP destroyed after commit; retry recovers same result; `paymentCount=1` after 3 attempts | ✓ |
| `crash-after-payment` | HTTP 503 on first attempt; retry delivers `fulfilled` with `paymentCount=1, serviceExecutions=1` | ✓ |
| `crash-after-job` | HTTP 503 after job; retry delivers `fulfilled`, `serviceExecutions=1`, `paymentCount=1` | ✓ |
| `concurrent` | 5 simultaneous requests; `attempts=5, paymentCount=1, serviceExecutions=1` | ✓ |

Events confirmed present for `lost-response`: `CREATED, RETRY, PAID, SERVICE_EXECUTED,
RECOVERED_RESULT, FAULT_INJECTED, RETRY, PAYMENT_REPLAY_BLOCKED, SERVICE_REUSED, REPLAYED_RESULT`.

---

## 5. CORS and CSP changes

### Problem (before)

The original patch (session 1) used a **reflected Origin** pattern:

```js
// BEFORE — unsafe for public deployment
res.setHeader('access-control-allow-origin', req.headers['origin'] || '*');
```

This is functionally equivalent to `Access-Control-Allow-Origin: *` — any origin is accepted,
which undermines CORS protection for an app accessible from a public URL.

### Fix (session 2)

Replaced with an explicit allowlist in `applyCors()`:

```
Allowed origins:
  *.preview.studio.arc.io   — Arc Studio workbench preview iframe
  localhost / 127.0.0.1     — local dev and Docker
  GHOSTPAY_ALLOWED_ORIGIN   — optional env var for self-hosted deployments
  (no Origin header)        — same-origin / server-to-server
```

Requests from any other origin receive no `Access-Control-Allow-Origin` header. Browsers block
those cross-origin requests. `Vary: Origin` is set to prevent cache poisoning.

CSP `connect-src` was tightened from `*` to `'self' https://rpc.testnet.arc.io https://rpc.mainnet.arc.io`.
The page only needs to reach the GhostPay API (same origin) and the Arc RPC for wallet calls in Arc mode.

**For a public deployment behind a custom domain**, set `GHOSTPAY_ALLOWED_ORIGIN=https://your-domain.com`
before starting the server, or serve the frontend from the same origin as the backend.

---

## 6. Live testnet payment — verified transactions

Real `GhostPay.pay()` transactions executed and confirmed on Arc Testnet:

| Call | Tx Hash | Explorer |
|---|---|---|
| First payment | `0x6d83dc091f01cb5ed4dd81dfbf0bfb2628dc443aaf5afbfe4cd41ede5aba4d03` | [View](https://explorer.testnet.arc.io/tx/0x6d83dc091f01cb5ed4dd81dfbf0bfb2628dc443aaf5afbfe4cd41ede5aba4d03) |
| Identical replay | `0xc4415e2083161ab56bfe7d8887b9afb38cefa0eaa2ec2ce66e064b7ba346645b` | [View](https://explorer.testnet.arc.io/tx/0xc4415e2083161ab56bfe7d8887b9afb38cefa0eaa2ec2ce66e064b7ba346645b) |

**First payment:** emitted `PaymentRecorded(paymentKey, payer, operationId, merchant, 100000, requestHash)`.
Merchant balance increased by 100 000 USDC units (0.10 USDC).

**Identical replay:** emitted `PaymentReplayed(paymentKey, payer, operationId)`. No USDC transfer occurred.
Merchant balance unchanged. `paymentCount=1` after both transactions.

Payer and merchant were separate addresses. `operationId` was a new unique `bytes32` for this test.

See `docs/TESTNET_PAYMENT_GUIDE.md` for the full step-by-step guide using `cast` or MetaMask.

---

## 7. Remaining steps before Arc Mainnet

1. **Source verification** — verify `GhostPay.sol` on the Arc Testnet explorer:
   ```bash
   forge verify-contract \
     --chain-id 5042002 \
     --rpc-url https://rpc.testnet.arc.io \
     --etherscan-api-key <EXPLORER_API_KEY> \
     --constructor-args $(cast abi-encode "constructor(address)" 0x3600000000000000000000000000000000000000) \
     0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874 \
     contracts/GhostPay.sol:GhostPay
   ```
2. **Independent security review** of `GhostPay.sol` before real funds. The contract has not
   been audited by a third party. Key areas: reentrancy guard correctness, `transferFrom` return
   value check, replay-parameter collision resistance.
3. **Mainnet deploy** from your own wallet (never via Arc Studio's platform wallet). See README.md.
4. **Public hosting** — `docker compose up --build` works on any host running Docker. Set env vars
   from `.env.example`. See section 8 for GitHub sync.

---

## 8. GitHub sync

The only files changed from the original repository are:

```
apps/server/src/app.js     — CORS/CSP fix (two sessions)
test/GhostPay.t.sol        — Foundry testFail* rename
AGENTS.md                  — new (agent memory, not tracked by original repo)
docs/ARC_STUDIO_REPORT.md  — new (this file)
docs/TESTNET_PAYMENT_GUIDE.md — new
contracts/contract-metadata/GhostPay.json — new (Arc Testnet deployment record)
```

To push these changes to `Nauvvi1/ghostpay-recovery` (assuming you have push access):

```bash
# From the project root:
git status                         # verify the diff
git diff apps/server/src/app.js    # review CORS/CSP changes
git diff test/GhostPay.t.sol       # review test rename

# Stage only the tracked files you want to push
git add apps/server/src/app.js
git add test/GhostPay.t.sol

# Optionally add the new docs
git add AGENTS.md
git add docs/ARC_STUDIO_REPORT.md
git add docs/TESTNET_PAYMENT_GUIDE.md
git add contracts/contract-metadata/GhostPay.json

git commit -m "fix: CORS allowlist, tighten CSP, fix Foundry testFail* naming

- Replace reflected-Origin CORS with an explicit allowlist (Arc Studio preview,
  localhost, optional GHOSTPAY_ALLOWED_ORIGIN env var).
- Tighten connect-src from * to 'self' + Arc RPC endpoints.
- Rename testFailedTransferDoesNotRecordReceipt -> test_RevertWhen_* (Foundry
  removed testFail* convention; test logic unchanged).
- Add Arc Testnet deployment record and development report."

git push origin main
```

If you do NOT have push access (it's a fork), open a PR:

```bash
git remote add fork https://github.com/<YOUR_GITHUB_USERNAME>/ghostpay-recovery.git
git push fork main
# Then open a PR on GitHub from your fork to Nauvvi1/ghostpay-recovery
```

The `data/` directory (SQLite files) and `contracts/out/` are already in `.gitignore`;
check that `.gitignore` also excludes `.env` before pushing.

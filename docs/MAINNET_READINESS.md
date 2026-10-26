# GhostPay — Arc Mainnet Readiness Report
*Prepared: 2026-10-26. Based on source review, bytecode verification and all available test suites.*

---

## Verdict: Conditionally ready for a limited mainnet test

GhostPay.sol is a small, focused contract (91 lines) with no upgrade mechanism, no admin keys,
and no off-chain oracle dependencies. The security properties are sound for the described use case.
Two issues must be resolved before spending real USDC; they are listed under **Blockers** below.

---

## 1. Contract Security Review — GhostPay.sol

### 1.1 Replay Protection ✓ STRONG

The key is `keccak256(abi.encode(payer, operationId))` — binding the receipt to BOTH the wallet
address and the operation ID.

- A replay with identical parameters returns `false` and emits `PaymentReplayed`.
  No USDC moves. ✓
- A replay with any changed parameter (`merchant`, `amount`, `requestHash`) reverts with
  `DifferentReplayParameters`. ✓
- A different payer with the same `operationId` produces a different key — payer isolation is
  enforced at the mapping level. ✓
- Tested: `testFirstPaymentAndReplayOnlyChargesOnce`, `testChangedMerchantRevertsWithoutExtraPayment`,
  `testChangedAmountOrHashReverts`, `testDifferentPayersHaveIsolatedOperationKeys`. All pass. ✓

### 1.2 Access Control ✓ CORRECT (minimal by design)

There are no owner, admin, or upgrader roles — this is intentional and correct for a payment
receipt registry. Nobody can pause it, drain it, or change stored receipts.

`merchant == msg.sender` is rejected (`ZeroAddress` revert). This prevents a payer from paying
themselves and inflating their own receipt. ✓

### 1.3 Reentrancy ✓ PROTECTED

Custom `nonReentrant` modifier with a `locked` flag (0 → 1 on entry, 1 → 0 on exit). The check
reverts with `Reentrancy()` if `locked == 1`.

One note: the locked flag is reset to **0** (falsy), not to a non-zero "clean" sentinel. This
is the standard pattern and is correct — the initial storage slot for `locked` is 0, so `0 → 1`
means "entering", `1 → 0` means "exited". No issue.

The receipt is written to storage **before** `transferFrom` is called. For USDC on Arc this is
not strictly required (USDC's `transferFrom` is not reentrancy-capable), but the write-first
pattern + nonReentrant is defence in depth. ✓

### 1.4 `transferFrom` Behaviour ✓ SAFE

`if (!usdc.transferFrom(msg.sender, merchant, amount)) revert USDCTransferFailed();`

The call checks the return value — not all ERC-20s revert on failure; some return `false`.
Circle's USDC on Arc does revert, but the explicit check protects against non-standard tokens
if the contract were ever redeployed with a different address. ✓

If `transferFrom` reverts (e.g. insufficient allowance), the entire transaction reverts atomically,
including the receipt write. The mapping stays clean. ✓
Tested: `test_RevertWhen_TransferFailsNoReceiptRecorded`. ✓

### 1.5 Payment Parameter Validation ✓ THOROUGH

| Check | Guard |
|---|---|
| `operationId == bytes32(0)` | `revert InvalidOperation()` |
| `requestHash == bytes32(0)` | `revert InvalidOperation()` |
| `merchant == address(0)` | `revert ZeroAddress()` |
| `merchant == msg.sender` | `revert ZeroAddress()` |
| `amount == 0` | `revert InvalidAmount()` |

No amount ceiling check (no maximum USDC). For the initial test (0.10 USDC) this is not a
practical risk, but integrators should note there is no on-chain cap.

### 1.6 Observations (non-blocking)

| Item | Severity | Notes |
|---|---|---|
| No amount ceiling | Low | No `maxAmount` guard. Calling `pay()` with an arbitrarily large amount that exceeds the allowance will revert (no funds move). Unlikely to matter for a 0.10 USDC test but worth noting for production. |
| No event for `USDCTransferFailed` | Low | The revert is clear from the error selector; a failed transfer leaves no trace in logs which is fine since the whole tx reverts anyway. |
| `usdc` is `public immutable` | Info | Anyone can verify the USDC address the contract was deployed with by calling `usdc()`. Already confirmed on testnet: returns `0x3600000000000000000000000000000000000000`. ✓ |
| No source verification on testnet explorer | Info | Blockscout API returned no verified source for the testnet deployment. Consider `forge verify-contract` before mainnet (see Deployment Checklist). |
| Not independently audited | **Risk** | See Blockers. |

---

## 2. Source and Deployment Artifact Verification

| Check | Result |
|---|---|
| Testnet deployed bytecode length | 2754 chars |
| Local Foundry artifact bytecode length | 2754 chars |
| Bytecode prefix (first 40 chars) | Identical |
| Divergence point | Index 268 — the `immutable` USDC address slot (expected) |
| USDC address in deployed code | `0x3600...0000` present ✓ |
| `usdc()` read_contract call (live) | `0x3600000000000000000000000000000000000000` ✓ |
| Foundry compiler | `solc 0.8.24`, optimizer 200 runs |

**Conclusion:** The on-chain bytecode at `0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874` matches
the local source compiled with the same settings. The only difference is the immutable USDC
address substituted by the linker, which is the correct and expected behaviour.

---

## 3. Arc Mainnet Configuration

| Parameter | Value | Source |
|---|---|---|
| Chain ID | `5042` (hex `0x13B2`) | Arc docs + use-arc skill |
| RPC URL | `https://rpc.mainnet.arc.io` | Arc docs |
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` | Arc fixed predeploy (same on mainnet and testnet) |
| Explorer | `https://explorer.arc.io` | Arc docs |
| Native gas token | USDC (6-decimal ERC-20 view) | Arc architecture |

**Current default in `config.js`:** chain ID defaults to `5042`, RPC to `https://rpc.mainnet.arc.io`.
This is correct for mainnet. For testnet, `ARC_CHAIN_ID=5042002` and `ARC_RPC_URL=https://rpc.testnet.arc.io`
must be set. The Vercel deployment currently uses demo mode with no chain ID set.

---

## 4. Deployment Workflow (using MetaMask — no private key export)

### Prerequisites

- MetaMask (or any EIP-1193 wallet) with Arc Mainnet configured.
- Wallet funded with USDC on Arc Mainnet. Arc uses USDC as native gas — you need USDC to pay
  for gas, not ETH.
- Foundry (`forge`, `cast`) installed locally.

### Add Arc Mainnet to MetaMask

| Field | Value |
|---|---|
| Network name | Arc Mainnet |
| RPC URL | `https://rpc.mainnet.arc.io` |
| Chain ID | `5042` |
| Currency symbol | USDC |
| Block explorer | `https://explorer.arc.io` |

### Deploy GhostPay.sol to Arc Mainnet

```bash
# Import your wallet interactively (no key in environment)
cast wallet import arc-mainnet-deployer --interactive
# Enter private key when prompted; it is encrypted and stored locally.

# Deploy
forge create contracts/GhostPay.sol:GhostPay \
  --constructor-args 0x3600000000000000000000000000000000000000 \
  --rpc-url https://rpc.mainnet.arc.io \
  --account arc-mainnet-deployer \
  --broadcast

# Record the deployed address, then verify source
forge verify-contract <DEPLOYED_ADDRESS> contracts/GhostPay.sol:GhostPay \
  --rpc-url https://rpc.mainnet.arc.io \
  --compiler-version 0.8.24 \
  --num-of-optimizations 200 \
  --constructor-args $(cast abi-encode "constructor(address)" 0x3600000000000000000000000000000000000000)
```

**Never use `--private-key $KEY` in a deployed environment. Use `--account <keystore>` instead.**

---

## 5. Minimal Real Payment Test Plan (0.10 USDC)

Use two separate MetaMask accounts: one as payer, one as merchant.

### Step 1 — Verify the contract reads correctly
```bash
cast call <CONTRACT_ADDRESS> "usdc()(address)" --rpc-url https://rpc.mainnet.arc.io
# Expected: 0x3600000000000000000000000000000000000000
```

### Step 2 — Prepare an operation via the backend
Set Vercel env vars (see Section 6), then:
```
POST /api/arc/prepare  { "payer": "<PAYER_WALLET>" }
# Returns: { operationId, requestHash, amountUnits: 100000, merchant: "<MERCHANT_WALLET>" }
```

### Step 3 — Approve exact USDC amount (payer wallet)
```
approve(contractAddress, 100000)   // 0.10 USDC — exact, no excess
```
This is done by the SDK inside `submitArcPayment()` only if allowance < amountUnits.

### Step 4 — First payment
```
GhostPay.pay(operationId, merchant, 100000, requestHash)
// Expected: returns true, emits PaymentRecorded, merchant balance +0.10 USDC
```

### Step 5 — Verify payer and merchant balances
```bash
cast call 0x3600000000000000000000000000000000000000 \
  "balanceOf(address)(uint256)" <PAYER_WALLET> \
  --rpc-url https://rpc.mainnet.arc.io
```

### Step 6 — Read the onchain receipt
```bash
cast call <CONTRACT_ADDRESS> \
  "paymentOf(address,bytes32)(address,uint256,bytes32,uint256)" \
  <PAYER_WALLET> <OPERATION_ID> \
  --rpc-url https://rpc.mainnet.arc.io
# Expected: merchant, 100000, requestHash, blockNumber
```

### Step 7 — Identical replay
```
GhostPay.pay(operationId, merchant, 100000, requestHash)
// Expected: returns false, emits PaymentReplayed, merchant balance UNCHANGED
```

### Step 8 — Recover via backend
```
POST /api/arc/recover  { "operationId": "<ID>" }
// Backend reads paymentOf() from chain, not from a browser-supplied hash.
// Returns: { recovered: true, verifiedOnchain: true, state: { paymentCount: 1, result: {...} } }
```

---

## 6. Vercel Environment Variables for Mainnet

Add these in your Vercel project → Settings → Environment Variables:

| Variable | Value | Notes |
|---|---|---|
| `PAYMENT_MODE` | `arc` | Enables on-chain mode; disables demo endpoints |
| `ARC_CONTRACT_ADDRESS` | `<MAINNET_DEPLOYED_ADDRESS>` | From Step 4 of deployment |
| `MERCHANT_ADDRESS` | `<YOUR_MERCHANT_WALLET>` | Must differ from payer wallet |
| `ARC_RPC_URL` | `https://rpc.mainnet.arc.io` | Already the default |
| `ARC_CHAIN_ID` | `5042` | Already the default |

**Recommended:** keep a separate Vercel deployment (e.g. a "production" domain) for mainnet
and leave the existing deployment in demo mode. This preserves the public Failure Lab.

---

## 7. Frontend Readiness for Live Payment Flow

The Vercel deployment at `arc-studio-cfe64d9dabbe491f8a5b1e9a.vercel.app` has all the
required frontend features:

| Feature | Status |
|---|---|
| `wallet_addEthereumChain` with Arc Mainnet config | ✓ In SDK `connectArc()` |
| `wallet_switchEthereumChain` | ✓ In SDK `connectArc()` |
| Exact allowance check before approval | ✓ SDK checks `allowance()` first |
| Preflight `paymentOf()` check before sending pay tx | ✓ SDK checks twice (before and after approval) |
| `eth_sendTransaction` for approve + pay | ✓ |
| `eth_getTransactionReceipt` polling (90s timeout) | ✓ |
| Backend `recoverArc` verifies from chain, not from browser-supplied hash | ✓ |
| Demo mode preserved when `arcReady: false` | ✓ |

**One blocker** exists in the frontend — see Section 9.

---

## 8. Gas Requirements

On Arc, gas is paid in USDC (same asset, native view with 18 decimals).
Approximate costs at typical Arc gas prices (not guaranteed — measure before mainnet):

| Operation | Approximate gas units | Notes |
|---|---|---|
| `approve(contract, 100000)` | ~46 000 | Standard ERC-20 approve |
| `GhostPay.pay(...)` first | ~155 937 | From Foundry test measurement |
| `GhostPay.pay(...)` replay | ~28 000 | Cheaper (no transfer, just read+emit) |
| `forge create` deployment | ~350 000–400 000 | One-time |

Arc gas prices are denominated in USDC and are stable by design.
Check `eth_gasPrice` against the live RPC before deploying to get an exact fee estimate.

---

## 9. Security Blockers and Missing Features

### BLOCKER 1 — No independent security audit

GhostPay.sol has not been reviewed by an external security firm. The contract holds no funds
(it only routes `transferFrom` calls), which limits blast radius, but the idempotency keys
and receipt storage have not been formally verified. Before spending meaningful amounts on
mainnet, commission an audit.

**Mitigation for limited test:** keep the first mainnet test to a single 0.10 USDC operation
with a separate dedicated test wallet containing no other funds.

### BLOCKER 2 — `wallet_addEthereumChain` hardcodes `chainName: 'Arc Mainnet'`

In `sdk/ghostpay.js` line 53:
```js
chainName:'Arc Mainnet',
```
This name is cosmetic and not a security issue, but it means testnet and mainnet use the same
`chainName` string in the MetaMask "Add Network" dialog. If a user has Arc Testnet already
added, MetaMask may show a confusing duplicate.

**Fix required before mainnet (one line):** pass the chain name from the backend config:

```js
// In sdk/ghostpay.js connectArc():
chainName: cfg.chainName || 'Arc Mainnet',
```

```js
// In api/lib/handler.js /api/config response:
chainName: chainId === 5042 ? 'Arc Mainnet' : 'Arc Testnet',
```

This is a one-line SDK change and a one-field API change, not a redesign.

### NOT a blocker — `locked` reset to 0

The reentrancy guard resets `locked = 0` instead of `locked = 2` (the OpenZeppelin pattern).
Since USDC on Arc is not a reentrancy-capable token and the pattern is correct (0 = unlocked,
1 = locked), this is safe but is worth noting for auditors.

### NOT a blocker — No refund mechanism

If a payment is recorded but the backend fails to deliver the API response permanently (e.g.
the backend is taken down entirely), the payer cannot claim a refund onchain. The contract has
no refund function. This is a design choice documented in the contract's NatSpec comment:
"This contract does NOT guarantee external API fulfillment or automatic refunds."

---

## 10. Rollback and Incident Response

GhostPay.sol is **not upgradeable** and has **no admin functions**. There is no onchain rollback.

| Scenario | Response |
|---|---|
| Payment sent but backend offline | Client retries with same `operationId`; backend recovers from `paymentOf()` on chain. |
| Wrong merchant address configured | Already-recorded receipts are immutable. Future operations use the new merchant. Inform affected payer to request an off-chain refund from the merchant. |
| Contract bug discovered | Deploy a new contract. Existing receipts remain in the old contract but are verifiable. Update `ARC_CONTRACT_ADDRESS` and `MERCHANT_ADDRESS` env vars. The old contract cannot be paused. |
| Vercel function down | Demo mode unaffected. Arc mode: client retries; `recoverArc` will work as soon as backend recovers, because the source of truth is onchain. |

---

## 11. Contract Verification Steps

```bash
forge verify-contract \
  <MAINNET_DEPLOYED_ADDRESS> \
  contracts/GhostPay.sol:GhostPay \
  --rpc-url https://rpc.mainnet.arc.io \
  --compiler-version 0.8.24 \
  --num-of-optimizations 200 \
  --constructor-args $(cast abi-encode "constructor(address)" 0x3600000000000000000000000000000000000000)
```

If the Arc explorer uses Sourcify, also submit:
```bash
forge verify-contract \
  <MAINNET_DEPLOYED_ADDRESS> \
  contracts/GhostPay.sol:GhostPay \
  --verifier sourcify \
  --rpc-url https://rpc.mainnet.arc.io
```

---

## Test Evidence Summary

| Suite | Tests | Result |
|---|---|---|
| Foundry Solidity (GhostPay.t.sol) | 6/6 | All pass |
| JS integration (engine.test.js) | 12/12 | All pass |
| Turso repository (turso-repository.test.js) | 14/14 | All pass |
| SDK regression (sdk-fetch-binding.test.js) | 5/5 | All pass |
| **Total** | **37/37** | **All pass** |

Live testnet transactions (Arc Testnet):
- First payment: `0x6d83dc091f01cb5ed4dd81dfbf0bfb2628dc443aaf5afbfe4cd41ede5aba4d03`
- Identical replay (no transfer): `0xc4415e2083161ab56bfe7d8887b9afb38cefa0eaa2ec2ce66e064b7ba346645b`

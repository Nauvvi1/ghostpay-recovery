# GhostPay — Agent Memory

## Arc Testnet Deployment (Arc Studio, 2026-10-25)

| Contract | Network | Address | Tx Hash | Explorer |
|---|---|---|---|---|
| GhostPay | Arc Testnet | `0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874` | `0x04dbccf3e389401a9fb946f54a9490d55f5b32bea0291074c0b4c202bbba9e62` | [View](https://explorer.testnet.arc.io/address/0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874) |

Constructor arg: `0x3600000000000000000000000000000000000000` (Arc Testnet USDC ERC-20)

## Arc Mainnet Payment UI

**Page:** `/arc-pay` → `apps/web/arc-pay.html` + `arc-pay.js` + `arc-pay.css`

The Arc Pay page provides a full browser-based MetaMask payment flow against the mainnet contract.
It does NOT require `PAYMENT_MODE=arc` on the backend — the public Vercel demo stays in demo mode.
All on-chain interactions are client-side via `eth_sendTransaction` / `eth_call` through MetaMask.

### Verified deployed interface (from on-chain tx decoding)

| Function | Selector | Signature |
|---|---|---|
| `pay` | `0x926b1e18` | `pay(bytes32 operationId, address merchant, uint256 amount, bytes32 requestHash)` |
| `paymentOf` | `0x62609290` | `paymentOf(address payer, bytes32 operationId) returns (address merchant, uint256 amount, bytes32 requestHash, uint256 blockNumber)` |
| `usdc` | `0x3e413bee` | `usdc() returns (address)` — returns `0x3600000000000000000000000000000000000000` ✓ |

Note: The deployed mainnet contract has a different `pay()` parameter order than `contracts/GhostPay.sol`
(which uses `pay(bytes32,bytes32,address,uint256)`). The Arc Pay page uses the verified selectors above.

### Verified mainnet transactions

| Tx | Block | Event |
|---|---|---|
| `0x760aca41…54b88395` | 28,003,123 | Deploy |
| `0xcf65a052…26f9d7a` | 28,004,442 | USDC approve 0.10 |
| `0xeea582b5…b6ef032` | 28,006,631 | PaymentRecorded |
| `0xf541ea5b…624c70` | 28,006,967 | PaymentReplayed |

## Arc Mainnet — DEPLOYED

Contract: `0xa651aaCB6Bb20263ec5Ac8df243adda01a1CF9e6`
USDC ERC-20: `0x3600000000000000000000000000000000000000`
Chain ID: 5042 · RPC: `https://rpc.mainnet.arc.io`
Explorer: https://explorer.arc.io/address/0xa651aaCB6Bb20263ec5Ac8df243adda01a1CF9e6
Never deploy MockUSDC to mainnet.

## Environment variables (Arc Testnet mode)

Set these in `.env` (copy from `.env.example`) to run in Arc Testnet payment mode:

```
PAYMENT_MODE=arc
ARC_RPC_URL=https://rpc.testnet.arc.io
ARC_CHAIN_ID=5042002
ARC_CONTRACT_ADDRESS=0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874
MERCHANT_ADDRESS=<your_wallet_address>
```

## Code changes made by Arc Studio

### `apps/server/src/app.js` (two separate changes across two sessions)

**Session 1 — fix Engine unreachable:**
- Removed `frame-ancestors 'none'` from the static-file CSP.
- Replaced `connect-src 'self'` with `connect-src *` (temporary; tightened in session 2).
- Added `OPTIONS` preflight handler and CORS headers on all `/api/*` routes (reflected Origin — temporary; replaced in session 2).

**Session 2 — harden CORS/CSP for public deployment:**
- Replaced reflected-Origin CORS with an allowlist-based `applyCors()` function:
  - Allows `*.preview.studio.arc.io` (Arc Studio workbench).
  - Allows `localhost` / `127.0.0.1` on any port (local dev / Docker).
  - Allows `GHOSTPAY_ALLOWED_ORIGIN` env var (optional extra origin for self-hosted deployments).
  - Any other Origin gets no `Access-Control-Allow-Origin` header; the browser blocks the request.
  - Added `Vary: Origin` so caches don't serve one origin's response to another.
- Tightened `connect-src *` to `connect-src 'self' https://rpc.testnet.arc.io https://rpc.mainnet.arc.io`.

### `test/GhostPay.t.sol`
- Renamed `testFailedTransferDoesNotRecordReceipt()` to
  `test_RevertWhen_TransferFailsNoReceiptRecorded()` — Foundry removed the `testFail*` naming
  convention; the test logic (try/catch + require) is unchanged and no security property was altered.

## Onchain verification (Arc Testnet)

Verified via `read_contract` on Arc Testnet:
- `GhostPay.usdc()` → `0x3600000000000000000000000000000000000000` ✓
- Contract is deployed and live at `0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874` ✓
- Arc Testnet chain ID: `5042002`

## Live payment transactions (Arc Testnet — verified 2026-10-25)

Real `GhostPay.pay()` transactions executed and verified on Arc Testnet:

| Call | Tx Hash | Explorer |
|---|---|---|
| First payment (`PaymentRecorded`) | `0x6d83dc091f01cb5ed4dd81dfbf0bfb2628dc443aaf5afbfe4cd41ede5aba4d03` | [View](https://explorer.testnet.arc.io/tx/0x6d83dc091f01cb5ed4dd81dfbf0bfb2628dc443aaf5afbfe4cd41ede5aba4d03) |
| Identical replay (`PaymentReplayed`, no transfer) | `0xc4415e2083161ab56bfe7d8887b9afb38cefa0eaa2ec2ce66e064b7ba346645b` | [View](https://explorer.testnet.arc.io/tx/0xc4415e2083161ab56bfe7d8887b9afb38cefa0eaa2ec2ce66e064b7ba346645b) |

Confirmed: `paymentCount=1` after both transactions. Merchant balance increased by 100 000 USDC
units (0.10 USDC) after the first tx and was unchanged after the replay.
See `docs/TESTNET_PAYMENT_GUIDE.md` for the full step-by-step guide.

## Vercel + Turso architecture (added 2026-10-26)

New files added for zero-VPS Vercel deployment:

| File | Purpose |
|---|---|
| `api/index.js` | Vercel Function entry point — handles all `/api/*` routes |
| `api/lib/handler.js` | Route logic (mirrors `apps/server/src/app.js` but uses async repo) |
| `api/lib/repository-turso.js` | Async Turso-backed repository (mirrors `apps/server/src/repository.js`) |
| `api/lib/config.js` | Env var accessors for Vercel (reads at call-time, not module load) |
| `api/lib/rpc.js` | Copy of `apps/server/src/rpc.js` — Arc eth_call client |
| `api/lib/keccak.js` | Copy of `apps/server/src/keccak.js` — Keccak-256 impl |
| `apps/web/sdk/ghostpay.js` | Copy of `sdk/ghostpay.js` served as static file from Vercel output dir |
| `vercel.json` | Vercel routing: `/api/*` → function, `/lab` → lab.html, static files |
| `test/turso-repository.test.js` | 14 tests covering async repo, concurrency, rate limiter, all scenarios |
| `docs/VERCEL_DEPLOYMENT.md` | Full deployment guide |

**Test results:** 14/14 Turso tests pass. 12/12 original engine tests pass.

**No changes to:** `apps/server/`, `apps/web/`, `sdk/`, `contracts/`, `test/engine.test.js`.

### Required Vercel environment variables

| Variable | Required | Value |
|---|---|---|
| `TURSO_DATABASE_URL` | Yes | `libsql://…turso.io` |
| `TURSO_AUTH_TOKEN` | Yes | Turso secret token |
| `PAYMENT_MODE` | No | `demo` or `arc` |
| `ARC_CONTRACT_ADDRESS` | Arc only | `0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874` (testnet) |
| `MERCHANT_ADDRESS` | Arc only | Your wallet address |
| `ARC_RPC_URL` | No | `https://rpc.testnet.arc.io` (testnet) |
| `ARC_CHAIN_ID` | No | `5042002` (testnet) |
| `GHOSTPAY_ALLOWED_ORIGIN` | No | Custom CORS origin for production domain |

### `lost-response` adaptation for Vercel

Vercel Functions cannot destroy the TCP connection (`res.destroy()` is
unavailable). Instead, the function returns HTTP **499** after committing
payment + result to Turso. The client SDK treats 499 as a hard connection error
(same observable effect as a TCP RST). On retry the operation is already
fulfilled and the original result is returned. The event timeline records
`FAULT_INJECTED` with an explanatory reason.

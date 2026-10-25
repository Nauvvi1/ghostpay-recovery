# GhostPay — Agent Memory

## Arc Testnet Deployment (Arc Studio, 2026-10-25)

| Contract | Network | Address | Tx Hash | Explorer |
|---|---|---|---|---|
| GhostPay | Arc Testnet | `0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874` | `0x04dbccf3e389401a9fb946f54a9490d55f5b32bea0291074c0b4c202bbba9e62` | [View](https://explorer.testnet.arc.io/address/0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874) |

Constructor arg: `0x3600000000000000000000000000000000000000` (Arc Testnet USDC ERC-20)

## Arc Mainnet — NOT yet deployed

Arc Mainnet USDC ERC-20: `0x3600000000000000000000000000000000000000`
Deploy independently — see README.md and docs/ARC_STUDIO_GUIDE.md.
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

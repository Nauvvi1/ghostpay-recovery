# GhostPay — Recovery Engine for USDC-paid APIs

**Payment Recovery Protocol for AI Agents & APIs** · Arc hackathon MVP

GhostPay ensures that a retried application operation is **not paid twice** and that a **previously paid API result can be recovered** after a failure. The Solidity layer ensures at most one USDC debit per `(payer, operationId)`. The backend returns the original durable result when the same operation is retried. A deliberate TCP-drop test proves the failure path is real, not a slideshow.

![Mode](https://img.shields.io/badge/Mode-Local%20demo%20%7C%20Arc%20Mainnet-82edc1) ![Node](https://img.shields.io/badge/Node-22%2B-lightgrey) ![Dependencies](https://img.shields.io/badge/Runtime%20deps-0-lightgrey)

![GhostPay dashboard preview](docs/dashboard-preview.png)

## Quick start — full working local demo

Requires **Node.js 22.13+** (Node 22 has an experimental built-in SQLite API).

```bash
npm run dev
# Open http://127.0.0.1:4173
```

**No `npm install`, blockchain wallet, funded account or API key is required for the demo.** The dashboard and HTTP backend are included, all in JavaScript. SQLite persists the operation journal under `data/ghostpay.sqlite` across restarts.

```bash
npm test             # recovery, concurrency, ABI encoding and RPC verification tests
npm run smoke        # launches a local HTTP server and exercises the loss/retry path
npm run check        # JavaScript syntax check
```

### Interactive fault cases

| Scenario | Injected behavior | Recovered behavior |
|---|---|---|
| Lost response | **Real TCP socket is dropped** after saving settlement + result | Retry returns original result, one simulated debit |
| Crash after payment | 503 after durable settlement, before provider work | Retry performs provider job once |
| Crash after job | 503 after provider output committed, before response finalized | Retry returns already-saved output |
| Concurrent requests | Five simultaneous HTTP requests for one operation ID | One simulated debit and one service execution |

Local simulation records represent a **simulated** USDC settlement. **They are not onchain transactions.** The demo output is a deterministic sample report, not an external AI inference.

## What is actually implemented

- `contracts/GhostPay.sol`: Solidity 0.8.24 USDC payer/operation receipt registry, parameter replay checking, safe atomic transfer+record, reentrancy protection, events, and `paymentOf` onchain recovery.
- `sdk/ghostpay.js`: dependency-free EIP-1193 browser SDK; creates/retries operations, switches Arc network, checks existing settlement before a new payment, exact-amount USDC approval, wallet submission and receipt monitoring.
- `apps/server`: Node.js built-in HTTP and SQLite backend, atomic state transitions, simulated settlement, real Arc RPC settlement verification, persisted one-time service results, complete timeline.
- `apps/web`: interactive Failure Lab/dashboard, run/replay buttons, event timeline, Arc wallet flows, persistent last operation ID.
- `test/`: automated Node tests for dropped connections, retries, persistence and RPC; and self-contained Foundry Solidity unit tests for settlement invariants.

## Arc Mainnet mode — requires your deployment

Arc mainnet is **chain ID `5042`** with RPC `https://rpc.mainnet.arc.io`. The native gas token is USDC (18 native decimals); the **ERC-20 interface** is at `0x3600000000000000000000000000000000000000` (**6 decimals**). GhostPay transfers `100000` ERC-20 units = **0.10 USDC**.

1. In [Arc Studio](https://studio.arc.io/), use the detailed generation/review steps in [`docs/ARC_STUDIO_GUIDE.md`](docs/ARC_STUDIO_GUIDE.md). This is important for **Arc Microgrants eligibility**.
2. Independently compile, audit/test and deploy `contracts/GhostPay.sol` with constructor argument `0x3600000000000000000000000000000000000000` on Arc Mainnet. The Studio service itself does not fund/sign/deploy mainnet transactions. Verify the contract source and ABI in [Arc Explorer](https://explorer.arc.io).
3. Create `.env` (not committed) or export environment variables. Node reads exported env vars; `.env` is an example file, not automatically loaded (see below).

```bash
# Bash/macOS/Linux example (replace both addresses)
export PAYMENT_MODE=arc
export ARC_RPC_URL=https://rpc.mainnet.arc.io
export ARC_CHAIN_ID=5042
export ARC_CONTRACT_ADDRESS=0xYOUR_DEPLOYED_GHOSTPAY_CONTRACT
export MERCHANT_ADDRESS=0xYOUR_MERCHANT_WALLET
npm run dev
```

On Windows PowerShell set `$env:PAYMENT_MODE='arc'` (and the remaining `$env:...` entries). Node 22 also supports `node --env-file=.env apps/server/src/server.js` if you populate `.env` from `.env.example`.

4. Open the Arc Mainnet tab, connect an **EIP-1193 wallet**, prepare a new operation, review an exact USDC approval if needed, and confirm a real payment + gas. The backend reads `paymentOf` on Arc directly and returns the original result; hitting **Recover from Arc** never sends a new transfer.
5. Save your actual tx hash, contract address, explorer link, and Arc Studio project URL. **None are included or fabricated** in this archive.

**Safety:** the demo is not audited. Do not use meaningful funds. Exact approval costs gas, retries at contract level also cost gas, and merchant receives tokens immediately (this is *not* an escrow/refund protocol). No private keys are handled by the server or app.

## Docker

`docker compose up --build` runs the same locally accessible simulation at `http://127.0.0.1:4173`; data is stored in a named volume. Arc mode still requires correct environment settings and a funded browser wallet.

## Programmatic usage

```js
import { GhostPayClient } from './sdk/ghostpay.js';
const ghostpay = new GhostPayClient({ baseUrl: 'http://127.0.0.1:4173' });
const order = await ghostpay.startDemo();
try { await ghostpay.attemptDemo(order.operationId, 'lost-response'); }
catch { /* TCP response was intentionally lost */ }
const recovered = await ghostpay.attemptDemo(order.operationId, 'lost-response');
console.log(recovered.state.result);  // stored, paid result
```

In Arc Mainnet mode use `connectArc(config)`, `prepareArc(payer)`, `submitArcPayment(operation,config)` and `recoverArc(operationId)`; private keys remain in the wallet. The `operationId` must be preserved by your API client; losing it and creating a new operation is NOT protected against another payment.

## Architecture / caveats

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). This is a runnable **hackathon MVP**, not independently audited, not a real-money deployment, and not universally exactly-once for arbitrary third-party service effects. `Payment Recovery` means confirming USDC settlement and recovering a result from a cooperating, idempotent service. Service outages and malicious nonfulfillment may still require provider-side compensation/refunds.

## Tests & quality

Tests run without npm dependencies. Run `forge test -vv` after installing [Foundry](https://book.getfoundry.sh/) to compile the Solidity files and exercise contract unit tests. Solidity must still be independently reviewed/audited before mainnet submission; this ZIP does not claim Solidity compilation or Arc deployment already happened.

MIT License — see `LICENSE`.

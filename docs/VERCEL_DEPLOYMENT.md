# GhostPay — Vercel Deployment Guide

GhostPay runs entirely on Vercel (frontend + Node.js serverless functions) with
Turso Cloud as the persistent libSQL database.  No VPS, no Docker, no managed
PostgreSQL required.

## Architecture

```
Browser
  │
  ├── GET /          → apps/web/index.html   (landing page)
  ├── GET /lab       → apps/web/lab.html     (Failure Lab dashboard)
  ├── GET /sdk/*.js  → apps/web/sdk/         (browser SDK)
  └── /api/*         → api/index.js          (Vercel Node.js Function)
                           └── api/lib/
                                ├── handler.js           (route logic)
                                ├── repository-turso.js  (async Turso repo)
                                ├── config.js            (env var accessors)
                                ├── rpc.js               (Arc eth_call client)
                                └── keccak.js            (Keccak-256 impl)
```

The original `apps/server/` Node.js HTTP server is **unchanged** and continues
to work for local development and self-hosted / Docker deployments.

---

## Prerequisites

1. A [Vercel](https://vercel.com) account (free tier is sufficient).
2. A [Turso](https://turso.tech) account (free tier: 500 databases, 1 GB
   storage, 1 billion row reads/month).
3. Your GitHub repository connected to Vercel.

---

## Step 1 — Create a Turso database

```bash
# Install the Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Authenticate
turso auth login

# Create the database
turso db create ghostpay

# Get the connection URL and auth token
turso db show ghostpay --url
turso db tokens create ghostpay
```

Save the URL (starts with `libsql://`) and the token — you will add them to
Vercel as environment variables.

The schema is created automatically on the first cold start: `api/index.js`
calls `repo.initSchema()` which runs `CREATE TABLE IF NOT EXISTS …` statements.
No manual migration step is required.

---

## Step 2 — Deploy to Vercel

### Option A — Vercel CLI

```bash
npm install -g vercel
vercel login
vercel --prod
```

When prompted, Vercel detects `vercel.json` and configures the project
automatically.

### Option B — GitHub integration (recommended)

1. Open https://vercel.com/new and import `Nauvvi1/ghostpay-recovery`.
2. Vercel reads `vercel.json` and configures routing automatically.
3. Add environment variables (see Step 3) before the first deployment.

---

## Step 3 — Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**.
All are available to both Preview and Production deployments.

| Variable | Required | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | **Yes** | libsql://…turso.io database URL |
| `TURSO_AUTH_TOKEN` | **Yes** | Turso database auth token (keep secret) |
| `PAYMENT_MODE` | No | `demo` (default) or `arc` for live Arc payments |
| `ARC_CONTRACT_ADDRESS` | Arc mode only | Deployed `GhostPay.sol` address |
| `MERCHANT_ADDRESS` | Arc mode only | Your Arc wallet address for payments |
| `ARC_RPC_URL` | No | Arc RPC endpoint (default: `https://rpc.mainnet.arc.io`) |
| `ARC_CHAIN_ID` | No | Arc chain ID (default: `5042` for mainnet) |
| `GHOSTPAY_ALLOWED_ORIGIN` | No | Extra allowed CORS origin for custom domains |

**Security notes:**
- `TURSO_AUTH_TOKEN` is a server-side secret. Vercel never exposes it to the
  browser. Do not prefix it with `NEXT_PUBLIC_` or `VITE_`.
- `ARC_CONTRACT_ADDRESS` and `MERCHANT_ADDRESS` are public values (wallet
  addresses are on-chain) but they are still server-side env vars here because
  they are only used by the API function, not the browser.
- Never set a private key as an environment variable. The SDK uses the user's
  browser wallet (EIP-1193) for all Arc transactions.

---

## Step 4 — Arc Testnet deployment (already done)

The GhostPay contract is already deployed on Arc Testnet:

- **Contract:** `0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874`
- **USDC:** `0x3600000000000000000000000000000000000000` (Arc predeploy)
- **First payment tx:** `0x6d83dc091f01cb5ed4dd81dfbf0bfb2628dc443aaf5afbfe4cd41ede5aba4d03`
- **Replay tx:** `0xc4415e2083161ab56bfe7d8887b9afb38cefa0eaa2ec2ce66e064b7ba346645b`

To enable Arc mode on Vercel (testnet):

```
PAYMENT_MODE=arc
ARC_CONTRACT_ADDRESS=0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874
MERCHANT_ADDRESS=<your testnet wallet>
ARC_RPC_URL=https://rpc.testnet.arc.io
ARC_CHAIN_ID=5042002
```

---

## Step 5 — Verify the deployment

```bash
# Health check
curl https://your-project.vercel.app/api/health
# → {"ok":true,"mode":"demo"}

# Config
curl https://your-project.vercel.app/api/config

# Create a demo operation
curl -X POST https://your-project.vercel.app/api/demo/start \
  -H "content-type: application/json" -d '{}'
```

---

## Local development

The existing Node.js server continues to work locally (SQLite, no Turso needed):

```bash
npm run dev       # starts on port 4173 by default
npm test          # original 12 engine tests
npm run test:turso  # 14 Turso repository tests (uses :memory: — no Turso account)
npm run test:all  # all 26 tests
npm run check     # syntax check all source files
```

To test the Vercel function layer locally, install the Vercel CLI and run:

```bash
vercel dev
```

This starts a local dev server that invokes `api/index.js` via the Vercel
runtime, using a `.env.local` file for secrets.

---

## Failure Lab scenarios on Vercel

All four Failure Lab scenarios work correctly under serverless invocations
because Turso is the durable store — no in-memory state is relied upon.

| Scenario | Local (VPS) | Vercel |
|---|---|---|
| `crash-after-payment` | 503 + retry | 503 + retry (identical) |
| `crash-after-job` | 503 + retry | 503 + retry (identical) |
| `concurrent` (5×) | 1 payment, 1 job | 1 payment, 1 job (identical) |
| `lost-response` | TCP RST → retry | HTTP 499 → retry |

**`lost-response` on Vercel:** Vercel Functions control the HTTP transport,
so `res.destroy()` (raw TCP close) is not available. Instead the function
returns HTTP **499** (client closed request / connection abort) after committing
the result to Turso. The GhostPay SDK treats any non-2xx response as a
connection error, matching the client-observable behaviour of the TCP drop: the
caller sees a hard failure, but payment and result are durably stored. On retry,
the operation is found fully finalized and the original result is returned.
The event timeline records `FAULT_INJECTED` with the reason explaining the
serverless adaptation.

---

## Mainnet deployment checklist

1. Complete an independent security audit of `GhostPay.sol`.
2. Deploy `GhostPay.sol` to Arc Mainnet (chain ID 5042) from your own wallet.
3. Set `PAYMENT_MODE=arc`, `ARC_CONTRACT_ADDRESS`, `MERCHANT_ADDRESS`,
   `ARC_RPC_URL=https://rpc.mainnet.arc.io`, `ARC_CHAIN_ID=5042` in Vercel.
4. Do NOT use MockUSDC on mainnet. The Arc predeploy USDC at
   `0x3600000000000000000000000000000000000000` is the only USDC on Arc.
5. Test with a small amount (0.10 USDC) before enabling production traffic.

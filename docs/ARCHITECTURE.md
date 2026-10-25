# GhostPay Recovery Engine — design and guarantees

## Trust boundary

- **Arc EVM contract** is authoritative for settlement. Unique key = `keccak256(abi.encode(payer, operationId))`.
- **Backend** is authoritative for service execution/results, with SQLite `UNIQUE(operation_id)` durability and transactional writes.
- **Browser** is NOT trusted for settlement: the backend calls `paymentOf` directly against the configured Arc RPC and checks `payer`, `merchant`, `requestHash`, `amount` and correct chain + token.
- **Failure Lab** simulates settlement inside SQLite; it is **not** a blockchain transaction.

## State diagram

```text
CREATED --verify/settle--> PAID --execute job--> JOB_SAVED --finalize--> FULFILLED
   |                       |                   |                         |
   +-- retry existing ID --+-------------------+---- recover + replay --+
```

The relational state uses CREATED, PAID, FULFILLED. An intermediate JOB_SAVED is represented by a durable `jobs` row before response finalization. Each run of `recoverArc` verifies the contract again, then recovers the job/response without creating a new transfer.

## Exactly-once scope

- **Proven by design:** at most one successful `transferFrom` for each `(payer, operationId)` in this GhostPay contract, for identical payment parameters. A competing request cannot double debit the same operation. Reverts roll back the onchain receipt. Explicit onchain replay still consumes gas.
- **Local demo:** at most one SQLite payment ledger row per operation and at most one durable service-job row. Synchronous DB transactions serialize concurrent requests; unique constraints provide the last line of defense.
- **Not guaranteed:** arbitrary external services with side effects, multi-region consistency, token contract correctness, malicious API provider behavior, chargebacks, automatic refunds, universal exactly-once execution. Merchant receives USDC immediately; GhostPay does not escrow funds.
- **Production considerations:** Sign-in with Ethereum and authorization, provider idempotency keys, a job/outbox worker for long tasks, tracing, secrets manager, hosted multi-instance DB, audit, rate limiting, TLS, and resilience across RPC providers. This is a hackathon MVP, not audited financial infrastructure.

## Failure injection

- `lost-response`: real TCP disconnect **after** settlement + job + response have been persisted.
- `crash-after-payment`: HTTP 503 representing a worker crash, payment persisted; service not yet run.
- `crash-after-job`: HTTP 503 after persisting provider output, before response table is finalized.
- `concurrent`: five simultaneous requests with the **same** operation ID; one ledger payment and job.

## Mainnet operation

1. Backend creates random 32-byte operation ID and SHA-256 request commitment.
2. Browser connects an EIP-1193 wallet on Arc Mainnet, approves *exact* allowance if needed, calls `pay`.
3. If the HTTP response or wallet confirmation is lost, the operation ID suffices to recover. The backend calls `paymentOf` over JSON-RPC and verifies chain state without relying on txHash supplied by user.
4. The original provider result is created once in a durable DB row and returned on future attempts. Refreshing/retrying **never** sends a new payment from the backend.

Token distinction: native USDC is used for **gas** with 18 decimal places; ERC-20 USDC is handled via `0x3600000000000000000000000000000000000000` with **6 decimals**. The fee requires an additional native balance.

## Project limitation

Solidity is included as human-readable source. You must independently compile, test, review and deploy it with Arc Studio or an EVM toolchain and verify deployed source on the explorer. This ZIP does not claim a live contract address, mainnet transaction, Arc Studio project ID, production audit, or grant qualification.

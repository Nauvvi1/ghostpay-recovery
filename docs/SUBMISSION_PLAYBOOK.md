# Arc Microgrants #2 — submission playbook

Competition URL: https://dorahacks.io/hackathon/arc-microgrants-2/detail

## Public product pitch (can be used after verification)

**GhostPay — Payment Recovery Protocol for AI Agents & Paid APIs**

Blockchain payments can settle successfully while the HTTP response fails. An automated agent retries and may accidentally send another payment for the same job. GhostPay anchors each payment to an immutable operation ID, checks the onchain USDC receipt on Arc, and restores a durable paid API result after timeouts, simulated server crashes, and concurrent retries. A live Failure Lab deliberately drops an HTTP connection after payment and shows five retries returning the original result without a second charge.

This is NOT another checkout button or escrow. It is a reliability layer bridging onchain settlement and offchain API fulfillment.

## 45-second demo script

1. **0–10 s:** Open Failure Lab. Show the 0.10 USDC service and choose **Lost response**. State explicitly this first test is simulated.
2. **10–20 s:** Press **Simulate failure & recover**. The server performs settlement, runs the job, then intentionally closes the TCP connection before the client receives the HTTP response.
3. **20–30 s:** The client retries four more times using the same ID. Show **Payment executions: 1**, **Service executions: 1**, **Retry attempts: 4**, and the restored result.
4. **30–40 s:** Show concurrent retries and the replay-blocked event timeline.
5. **40–45 s:** Switch to Arc Mainnet and show your **actual deployed contract**, **real transfer** and **explorer proof** after configuring and funding it.

## Do not submit before you have

- A completed Arc Studio project with a real project link and saved relevant generated code.
- A deployed, source-verified **Arc mainnet** GhostPay contract.
- A real USDC transfer of 0.10 USDC (plus gas) using `pay` on mainnet, and an actual tx hash.
- A publicly accessible app, GitHub repository, recorded demo and screenshots.
- Reviewed contracts and executed `forge test -vv` after installing Foundry.

This archive includes source code and a local simulation but **none of these external submission proofs**. Do not invent or mislabel them.

## Engineering story for judges

- Onchain: `paymentKey = keccak256(abi.encode(payer, operationId))`, atomic receipt + `transferFrom`, replay parameter consistency, nonreentrancy.
- Backend: persistent SQLite `payments`/`jobs` tables keyed by operation ID, transactional state changes, idempotent service output.
- Recovery: uses `eth_call` on `paymentOf` as the settlement source of truth — the client need not possess a tx hash after a timeout.
- Testing: real TCP-drop simulation, simulated crashes at different phases, concurrent requests; repository persistence; Node automated tests + included Foundry test source.
- Non-goals: service-level exactly-once guarantee for arbitrary providers, fee-free retries, fraud-resistant refund/dispute resolution, audited custody.

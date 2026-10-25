# Arc Studio build instructions for hackathon eligibility

**Important:** GhostPay source code in this archive was authored independently. It has NOT yet been created or imported into the Arc Studio service. The competition requires meaningful Arc Studio use. Do not claim it was used until you have actually completed the steps below.

1. Open https://studio.arc.io/ and start a new project.
2. Use the prompt below and attach/paste `contracts/GhostPay.sol`, or import the GitHub repo if Arc Studio supports it.
3. Have Arc Studio review, improve and regenerate any needed app/contract code. Save/export its output, retain its public project link and commit its changes to GitHub.
4. Test, then deploy **independently to Arc Mainnet**, because Arc Studio itself does not sign or deploy mainnet transactions on your behalf.
5. Set `ARC_CONTRACT_ADDRESS`, `MERCHANT_ADDRESS` and `PAYMENT_MODE=arc`. Fund a wallet with real Arc USDC plus gas, make at least one real onchain payment, and collect a verified transaction hash.

## Prompt to paste into Arc Studio

> Build and review GhostPay, a failure-recovery payment protocol for paid APIs on Arc. Use canonical Arc USDC ERC-20 at `0x3600000000000000000000000000000000000000` (6 decimals), chain ID 5042. Users pay a merchant exactly once for each `(payer, bytes32 operationId)` even with concurrent/replayed calls. Solidity contract must verify identical replay parameters, ensure transfer and receipt storage are atomic, and protect reentrancy. Expose `pay(bytes32,address,uint256,bytes32)` and `paymentOf(address,bytes32)`. Add a TypeScript recovery client and an interactive dashboard demonstrating failures after settlement, after service execution, and during concurrent requests. Make recovery derive truth from Arc contract state, not browser-provided payment status. Keep a durable service-result database and return previous results on retry. Provide a local no-money simulation plus a separate opt-in Arc Mainnet flow that clearly warns about real USDC and gas. Add tests for duplicate transfers, mismatched replay, transfer failure and concurrency. Review the attached existing GhostPay contract and extend it, rather than creating a generic escrow.

Arc Studio docs: https://studio.arc.io/

## Evidence checklist

- [ ] Arc Studio project URL, screenshots and/or generated source committed
- [ ] GitHub repo with README, source code, and test result
- [ ] Verified GhostPay contract address on **Arc Mainnet**
- [ ] Real USDC transaction hash from a GhostPay `pay` call
- [ ] Public demo URL, short video and failure-recovery walkthrough

Never put an EOA private key into chat, GitHub or frontend configuration.

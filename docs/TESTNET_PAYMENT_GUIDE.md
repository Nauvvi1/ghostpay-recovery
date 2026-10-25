# GhostPay — Testnet Payment Guide

How to execute a real `GhostPay.pay()` transaction on Arc Testnet using two separate wallets,
verify idempotency on the second call, and record the events and balances.

**Contract:** `0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874` (Arc Testnet)  
**Arc Testnet RPC:** `https://rpc.testnet.arc.io`  
**Chain ID:** `5042002`  
**USDC (ERC-20, 6 decimals):** `0x3600000000000000000000000000000000000000`  
**Amount:** `100000` ERC-20 units = 0.10 USDC

---

## Option A — Using `cast` (Foundry)

You need two funded Arc Testnet wallets. Get USDC from https://faucet.circle.com (select
"Arc Testnet", request USDC to your payer address).

```bash
# Environment
export ARC_RPC=https://rpc.testnet.arc.io
export CONTRACT=0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874
export USDC=0x3600000000000000000000000000000000000000
export PAYER_KEY=<your_payer_private_key>
export PAYER=$(cast wallet address $PAYER_KEY)
export MERCHANT=<any_different_address>          # does not need a private key
export AMOUNT=100000                             # 0.10 USDC

# 1. Check payer USDC balance (ERC-20 view)
cast call $USDC "balanceOf(address)(uint256)" $PAYER --rpc-url $ARC_RPC

# 2. Check merchant USDC balance before
cast call $USDC "balanceOf(address)(uint256)" $MERCHANT --rpc-url $ARC_RPC

# 3. Create a unique operationId (must be bytes32)
export OP_ID=$(cast keccak "ghostpay-test-$(date +%s)")

# 4. Create a requestHash (commits to the service call)
export REQUEST_HASH=$(cast keccak "risk-report-v1-$OP_ID")

# 5. Check existing receipt (should be zero before first payment)
cast call $CONTRACT \
  "paymentOf(address,bytes32)(address,uint256,bytes32,uint256)" \
  $PAYER $OP_ID --rpc-url $ARC_RPC

# 6. Approve GhostPay to spend exactly 0.10 USDC
cast send $USDC \
  "approve(address,uint256)" $CONTRACT $AMOUNT \
  --private-key $PAYER_KEY --rpc-url $ARC_RPC

# 7. First payment — GhostPay.pay()
cast send $CONTRACT \
  "pay(bytes32,address,uint256,bytes32)(bool)" \
  $OP_ID $MERCHANT $AMOUNT $REQUEST_HASH \
  --private-key $PAYER_KEY --rpc-url $ARC_RPC

# Record the tx hash from the output above.

# 8. Check receipt — should show merchant, amount=100000, requestHash, blockNumber
cast call $CONTRACT \
  "paymentOf(address,bytes32)(address,uint256,bytes32,uint256)" \
  $PAYER $OP_ID --rpc-url $ARC_RPC

# 9. Check merchant balance — should have increased by 100000
cast call $USDC "balanceOf(address)(uint256)" $MERCHANT --rpc-url $ARC_RPC

# 10. Second call — identical replay (should return false, no second transfer)
cast send $CONTRACT \
  "pay(bytes32,address,uint256,bytes32)(bool)" \
  $OP_ID $MERCHANT $AMOUNT $REQUEST_HASH \
  --private-key $PAYER_KEY --rpc-url $ARC_RPC

# Record the second tx hash. Merchant balance should be unchanged.
cast call $USDC "balanceOf(address)(uint256)" $MERCHANT --rpc-url $ARC_RPC

# 11. Fetch events from both transactions
# PaymentRecorded event topic: $(cast keccak "PaymentRecorded(bytes32,address,bytes32,address,uint256,bytes32)")
# PaymentReplayed event topic: $(cast keccak "PaymentReplayed(bytes32,address,bytes32)")
cast logs \
  --from-block 0 \
  --address $CONTRACT \
  --rpc-url $ARC_RPC
```

### Expected results

| Step | Expected |
|---|---|
| First `pay()` return value | `true` (first payment) |
| `paymentOf` after first pay | merchant, amount=100000, requestHash, blockNumber > 0 |
| Merchant balance after first pay | increased by 100000 |
| Second `pay()` return value | `false` (replay, no transfer) |
| Merchant balance after second pay | unchanged |
| Events on first tx | `PaymentRecorded(paymentKey, payer, operationId, merchant, 100000, requestHash)` |
| Events on second tx | `PaymentReplayed(paymentKey, payer, operationId)` |

### Conflicting replay (different merchant — should revert)

```bash
cast send $CONTRACT \
  "pay(bytes32,address,uint256,bytes32)(bool)" \
  $OP_ID 0x000000000000000000000000000000000000dEaD $AMOUNT $REQUEST_HASH \
  --private-key $PAYER_KEY --rpc-url $ARC_RPC
# Expect revert: DifferentReplayParameters()
```

---

## Option B — Using MetaMask / browser wallet with the Arc mode tab

1. Deploy or use the existing contract: `0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874`.
2. Start the server with Arc Testnet environment variables:
   ```bash
   export PAYMENT_MODE=arc
   export ARC_RPC_URL=https://rpc.testnet.arc.io
   export ARC_CHAIN_ID=5042002
   export ARC_CONTRACT_ADDRESS=0xc0a490b3a7ad86d0a2c25d8d20ee2ca47b34e874
   export MERCHANT_ADDRESS=<your_merchant_wallet>
   npm run dev
   ```
3. Open `http://127.0.0.1:4173`, click the **Arc Mainnet** tab (label is "Mainnet" but works for
   testnet when `ARC_CHAIN_ID=5042002` is set).
4. Click **Connect Arc wallet** — MetaMask will prompt to add Arc Testnet.
5. Click **Prepare new 0.10 USDC operation** — creates the operation ID.
6. Click **Approve (if needed) & pay 0.10 USDC** — signs approval + pay() transaction.
7. Click **Recover from Arc** — verifies onchain receipt, returns result.

The operation timeline on the right panel shows every event including `CHAIN_VERIFIED`.

---

## Note on Arc Testnet chain ID

The GhostPay server config (`apps/server/src/config.js`) defaults `ARC_CHAIN_ID` to `5042`
(Arc mainnet). For Arc Testnet you must export `ARC_CHAIN_ID=5042002`. The RPC client verifies
the chain ID before every `paymentOf` call, so a wrong chain ID causes an immediate error rather
than a silent wrong-chain read.

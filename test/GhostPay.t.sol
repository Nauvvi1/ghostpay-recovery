// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { GhostPay } from "../contracts/GhostPay.sol";
import { MockUSDC } from "../contracts/MockUSDC.sol";

/** Self-contained Solidity tests. Run `forge test` (Foundry required).
 *  No forge-std, RPC funding or external imports needed.
 */
contract PayerActor {
    function approveToken(MockUSDC token, address spender, uint256 amount) external {
        require(token.approve(spender, amount), "approval failed");
    }
    function pay(GhostPay ghost, bytes32 op, address merchant, uint256 amount, bytes32 hash)
        external returns (bool)
    {
        return ghost.pay(op, merchant, amount, hash);
    }
}

contract GhostPayTest {
    MockUSDC token;
    GhostPay ghost;
    PayerActor buyer;
    PayerActor otherBuyer;
    address merchant = address(0xBEEF);
    bytes32 constant OP = keccak256("ghostpay-case-001");
    bytes32 constant REQUEST = keccak256("risk-report-v1");
    uint256 constant COST = 100000; // 0.10 USDC, 6 decimals

    function setUp() public {
        token = new MockUSDC();
        ghost = new GhostPay(address(token));
        buyer = new PayerActor();
        otherBuyer = new PayerActor();
        token.mint(address(buyer), 1000000);
        token.mint(address(otherBuyer), 1000000);
        buyer.approveToken(token, address(ghost), COST * 4);
        otherBuyer.approveToken(token, address(ghost), COST * 4);
    }

    function testFirstPaymentAndReplayOnlyChargesOnce() public {
        require(buyer.pay(ghost, OP, merchant, COST, REQUEST), "first should settle");
        require(!buyer.pay(ghost, OP, merchant, COST, REQUEST), "replay should not settle again");
        require(token.balanceOf(merchant) == COST, "duplicate debit");
        (address savedMerchant,uint256 savedAmount,bytes32 savedHash,uint256 blockNumber) =
            ghost.paymentOf(address(buyer), OP);
        require(savedMerchant == merchant && savedAmount == COST && savedHash == REQUEST,"bad receipt");
        require(blockNumber > 0, "missing block");
    }

    function testChangedMerchantRevertsWithoutExtraPayment() public {
        buyer.pay(ghost,OP,merchant,COST,REQUEST);
        bool reverted;
        try buyer.pay(ghost,OP,address(0xCAFE),COST,REQUEST) returns (bool) {reverted=false;}
        catch { reverted=true; }
        require(reverted,"changed merchant replay should revert");
        require(token.balanceOf(merchant)==COST,"unexpected merchant debit");
    }

    function testChangedAmountOrHashReverts() public {
        buyer.pay(ghost,OP,merchant,COST,REQUEST);
        bool amountFailed;
        try buyer.pay(ghost,OP,merchant,COST*2,REQUEST) returns (bool) {amountFailed=false;}
        catch {amountFailed=true;}
        require(amountFailed,"changed amount accepted");
        bool hashFailed;
        try buyer.pay(ghost,OP,merchant,COST,keccak256("other-request")) returns (bool) {hashFailed=false;}
        catch {hashFailed=true;}
        require(hashFailed,"changed request hash accepted");
    }

    function testDifferentPayersHaveIsolatedOperationKeys() public {
        buyer.pay(ghost,OP,merchant,COST,REQUEST);
        otherBuyer.pay(ghost,OP,merchant,COST,REQUEST);
        require(token.balanceOf(merchant)==COST*2,"payers should have separate receipts");
        require(ghost.paymentKey(address(buyer),OP)!=ghost.paymentKey(address(otherBuyer),OP),"collision");
    }

    // Renamed from testFail* — Foundry removed testFail* support in recent versions.
    // The test verifies that a transfer exceeding the payer's allowance reverts and
    // does NOT leave a receipt entry (atomicity guarantee).
    function test_RevertWhen_TransferFailsNoReceiptRecorded() public {
        bytes32 op2=keccak256("unfunded-request");
        bool reverted;
        try buyer.pay(ghost,op2,merchant,2000000,REQUEST) returns (bool) {reverted=false;}
        catch {reverted=true;}
        require(reverted,"should revert on insufficient token balance/allowance");
        (,uint256 saved,,)=ghost.paymentOf(address(buyer),op2);
        require(saved==0,"receipt must roll back on failed token transfer");
    }

    function testSeparateOperationsBothSettle() public {
        buyer.pay(ghost,OP,merchant,COST,REQUEST);
        buyer.pay(ghost,keccak256("second-operation"),merchant,COST,REQUEST);
        require(token.balanceOf(merchant)==COST*2,"different operations should settle separately");
    }
}

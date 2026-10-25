// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title GhostPay
 * @notice USDC payments identified by (payer, operationId), with durable onchain receipts.
 * @dev An already-settled payment is NEVER charged twice. An identical replay returns false
 *      while a conflicting replay reverts. The caller still pays network gas on retries.
 *      This contract does NOT guarantee external API fulfillment or automatic refunds.
 *      Integrators must persist responses and implement service-side idempotency.
 */
interface IERC20USDC {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract GhostPay {
    error ZeroAddress();
    error InvalidOperation();
    error InvalidAmount();
    error DifferentReplayParameters();
    error USDCTransferFailed();
    error Reentrancy();

    struct Receipt {
        address merchant;
        uint256 amount;           // USDC ERC-20: 6 decimal places, NOT 18.
        bytes32 requestHash;
        uint256 blockNumber;
    }

    IERC20USDC public immutable usdc;
    mapping(bytes32 => Receipt) private receipts;
    uint256 private locked;

    event PaymentRecorded(
        bytes32 indexed paymentKey,
        address indexed payer,
        bytes32 indexed operationId,
        address merchant,
        uint256 amount,
        bytes32 requestHash
    );
    event PaymentReplayed(bytes32 indexed paymentKey, address indexed payer, bytes32 indexed operationId);

    constructor(address usdcAddress) {
        if (usdcAddress == address(0)) revert ZeroAddress();
        usdc = IERC20USDC(usdcAddress);
    }

    modifier nonReentrant() {
        if (locked == 1) revert Reentrancy();
        locked = 1;
        _;
        locked = 0;
    }

    function paymentKey(address payer, bytes32 operationId) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, operationId));
    }

    function paymentOf(address payer, bytes32 operationId)
        external view returns (address merchant, uint256 amount, bytes32 requestHash, uint256 blockNumber)
    {
        Receipt memory receipt = receipts[paymentKey(payer, operationId)];
        return (receipt.merchant, receipt.amount, receipt.requestHash, receipt.blockNumber);
    }

    function pay(bytes32 operationId, address merchant, uint256 amount, bytes32 requestHash)
        external nonReentrant returns (bool firstPayment)
    {
        if (operationId == bytes32(0) || requestHash == bytes32(0)) revert InvalidOperation();
        if (merchant == address(0) || merchant == msg.sender) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();

        bytes32 key = paymentKey(msg.sender, operationId);
        Receipt storage old = receipts[key];
        if (old.amount != 0) {
            if (old.merchant != merchant || old.amount != amount || old.requestHash != requestHash)
                revert DifferentReplayParameters();
            emit PaymentReplayed(key, msg.sender, operationId);
            return false;
        }

        // The receipt and transfer happen in ONE EVM transaction. A failed transfer
        // automatically reverts the receipt write, and reentrancy is blocked.
        receipts[key] = Receipt({merchant:merchant,amount:amount,requestHash:requestHash,blockNumber:block.number});
        if (!usdc.transferFrom(msg.sender, merchant, amount)) revert USDCTransferFailed();
        emit PaymentRecorded(key, msg.sender, operationId, merchant, amount, requestHash);
        return true;
    }
}

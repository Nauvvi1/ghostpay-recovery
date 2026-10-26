// Shared configuration for Vercel API functions.
// Mirrors apps/server/src/config.js but reads from process.env at call-time
// (Vercel injects env vars per-invocation, not at module load time in dev).

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// arc-studio-allow-onchain-literal — canonical Arc USDC predeploy, same address on testnet and mainnet.
export const USDC_ADDRESS  = '0x3600000000000000000000000000000000000000';

// arc-studio-allow-onchain-literal — public Arc RPC fallback, same as apps/server/src/config.js.
export function getRpcUrl()         { return process.env.ARC_RPC_URL         || 'https://rpc.mainnet.arc.io'; }
export function getChainId()        { return Number(process.env.ARC_CHAIN_ID || 5042); }
export function getPaymentMode()    { return process.env.PAYMENT_MODE         || 'demo'; }
export function getContractAddress(){ return (process.env.ARC_CONTRACT_ADDRESS|| '').toLowerCase(); }
export function getMerchantAddress(){ return (process.env.MERCHANT_ADDRESS    || '').toLowerCase(); }

export const PRICE_UNITS = 100000;  // 0.10 USDC (6-decimal)
export const PRICE_USDC  = '0.10';

export function isAddress(value)  { return /^0x[0-9a-fA-F]{40}$/.test(value || ''); }
export function isBytes32(value)  { return /^0x[0-9a-fA-F]{64}$/.test(value || ''); }

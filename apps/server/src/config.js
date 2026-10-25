import { resolve } from 'node:path';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
export const RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.mainnet.arc.io';
export const CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042);
export const PAYMENT_MODE = process.env.PAYMENT_MODE || 'demo';
export const CONTRACT_ADDRESS = (process.env.ARC_CONTRACT_ADDRESS || '').toLowerCase();
export const MERCHANT_ADDRESS = (process.env.MERCHANT_ADDRESS || '').toLowerCase();
export const DB_FILE = resolve(process.env.GHOSTPAY_DB || './data/ghostpay.sqlite');
export const PRICE_UNITS = 100000;
export const PRICE_USDC = '0.10';
export function isAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(value || ''); }
export function isBytes32(value) { return /^0x[0-9a-fA-F]{64}$/.test(value || ''); }

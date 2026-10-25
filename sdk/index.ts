// TypeScript-friendly re-export: the tested implementation is the dependency-free JS ESM module.
export { GhostPayClient, GhostPayError } from './ghostpay.js';
export type { GhostPayConfig, GhostPayOperation, EventRecord, RpcWallet } from './ghostpay.js';

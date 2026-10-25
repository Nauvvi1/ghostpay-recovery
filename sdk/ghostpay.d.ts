export interface GhostPayConfig {
  mode: 'demo' | 'arc';
  arcReady: boolean;
  chainId: number;
  rpcUrl: string;
  contractAddress: string | null;
  merchantAddress: string | null;
  usdcAddress: string;
  amountUnits: number;
  amountUSDC: string;
  selectors: Record<'pay' | 'paymentOf' | 'approve' | 'allowance' | 'usdc' | 'balanceOf' | 'paidEvent',string>;
  explorer: string;
}
export interface EventRecord {
  event_id: number;kind:string;detail:string;created_at:string;
}
export interface GhostPayOperation {
  operationId: string;
  mode: 'demo' | 'arc';
  payer: string;
  merchant: string;
  requestHash: string;
  amountUnits: number;
  amountUSDC: string;
  status: 'created' | 'paid' | 'fulfilled';
  attempts: number;
  paymentCount: number;
  serviceExecutions: number;
  hasDurableJob: boolean;
  txHash: string | null;
  result: { reportId:string;riskScore:number;confidence:number;message:string;service:string } | null;
  events: EventRecord[];
}
export interface RpcWallet {
  request(args: { method:string; params?:any[] }): Promise<any>;
}
export class GhostPayError extends Error {
  status: number;
  body: unknown;
  constructor(message:string,status?:number,body?:unknown);
}
export class GhostPayClient {
  constructor(options?:{baseUrl?:string;fetcher?:typeof fetch;ethereum?:RpcWallet});
  request(method:string,path:string,data?:unknown):Promise<any>;
  getConfig():Promise<GhostPayConfig>;
  getStats():Promise<{operations:number;totalPayments:number;totalExecutions:number;retries:number}>;
  getOperation(operationId:string):Promise<GhostPayOperation>;
  startDemo():Promise<GhostPayOperation>;
  attemptDemo(operationId:string,scenario?:'normal'|'lost-response'|'crash-after-payment'|'crash-after-job'|'concurrent'):Promise<{recovered:boolean;state:GhostPayOperation}>;
  prepareArc(payer:string):Promise<GhostPayOperation>;
  recoverArc(operationId:string):Promise<{recovered:boolean;verifiedOnchain:boolean;blockNumber:string;state:GhostPayOperation}>;
  connectArc(config:GhostPayConfig):Promise<string>;
  submitArcPayment(op:GhostPayOperation,config:GhostPayConfig,options?:{onStep?:(message:string)=>void}):Promise<{alreadyPaid:boolean;txHash:string|null;approvalTx?:string|null}>;
  paymentOnChain(op:GhostPayOperation,config:GhostPayConfig):Promise<{merchant:string;amount:bigint;requestHash:string;blockNumber:bigint}>;
}

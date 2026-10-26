/**
 * GhostPay browser SDK — no third-party runtime dependencies.
 * EIP-1193 wallet required ONLY for live Arc. Demo mode uses HTTP alone.
 * Does not store, access or transmit wallet private keys.
 */
export class GhostPayError extends Error {
  constructor(message,status=0,body=null){ super(message);this.name='GhostPayError';this.status=status;this.body=body; }
}
const strip = x => x.replace(/^0x/i,'');
const toWord = value => strip(value).toLowerCase().padStart(64,'0');
const uintWord = value => BigInt(value).toString(16).padStart(64,'0');
const fromWords = hex => (hex.slice(2).match(/.{64}/g)||[]);
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
function receiptFields(data){
  const parts=fromWords(data||'0x');
  if(parts.length<4)throw new GhostPayError('Invalid paymentOf result (is the GhostPay contract deployed?)');
  return {merchant:'0x'+parts[0].slice(24),amount:BigInt('0x'+parts[1]),requestHash:'0x'+parts[2],blockNumber:BigInt('0x'+parts[3])};
}

export class GhostPayClient {
  constructor({baseUrl='',fetcher=globalThis.fetch?.bind(globalThis),ethereum=globalThis.ethereum}={}){
    this.baseUrl=baseUrl;this.fetcher=fetcher;this.ethereum=ethereum;
  }
  async request(method,path,data){
    let res;
    try{res=await this.fetcher(this.baseUrl+path,{method,headers:{'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});}
    catch(error){throw new GhostPayError(`Connection lost: ${error.message}`);}
    let payload;try{payload=await res.json();}catch{throw new GhostPayError('Invalid server response',res.status);}
    if(!res.ok)throw new GhostPayError(payload.error||`HTTP ${res.status}`,res.status,payload);
    return payload;
  }
  getConfig(){return this.request('GET','/api/config');}
  getStats(){return this.request('GET','/api/stats');}
  getOperation(operationId){return this.request('GET',`/api/operations/${encodeURIComponent(operationId)}`);}
  startDemo(){return this.request('POST','/api/demo/start',{});}
  attemptDemo(operationId,scenario='normal'){return this.request('POST','/api/demo/attempt',{operationId,scenario});}
  prepareArc(payer){return this.request('POST','/api/arc/prepare',{payer});}
  recoverArc(operationId){return this.request('POST','/api/arc/recover',{operationId});}
  async walletRequest(method,params=[]){
    if(!this.ethereum?.request)throw new GhostPayError('No EIP-1193 wallet detected. Install a compatible wallet.');
    return await this.ethereum.request({method,params});
  }
  async connectArc(cfg){
    const accounts=await this.walletRequest('eth_requestAccounts');
    if(!accounts?.[0])throw new GhostPayError('Wallet returned no account');
    const target='0x'+Number(cfg.chainId).toString(16);
    const chain=await this.walletRequest('eth_chainId');
    if(BigInt(chain)!==BigInt(cfg.chainId)){
      try{await this.walletRequest('wallet_switchEthereumChain',[{chainId:target}]);}
      catch(error){
        if(error.code===4902 || error?.data?.originalError?.code===4902){
          await this.walletRequest('wallet_addEthereumChain',[{
            chainId:target,chainName:cfg.chainName||'Arc Mainnet',rpcUrls:[cfg.rpcUrl],
            nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},blockExplorerUrls:[cfg.explorer]
          }]);
          await this.walletRequest('wallet_switchEthereumChain',[{chainId:target}]);
        }else throw error;
      }
    }
    const finalChain=await this.walletRequest('eth_chainId');
    if(BigInt(finalChain)!==BigInt(cfg.chainId))throw new GhostPayError('Switch wallet to Arc Mainnet');
    return accounts[0].toLowerCase();
  }
  async ethCall(to,data,from){return this.walletRequest('eth_call',[{to,data,...(from?{from}:{})},'latest']);}
  async waitReceipt(hash,{timeoutMs=90000}={}){
    const started=Date.now();
    while(Date.now()-started<timeoutMs){
      const receipt=await this.walletRequest('eth_getTransactionReceipt',[hash]);
      if(receipt){if(BigInt(receipt.status||0)!==1n)throw new GhostPayError('Onchain transaction reverted: '+hash);return receipt;}
      await delay(1300);
    }
    throw new GhostPayError(`Transaction not confirmed in ${Math.ceil(timeoutMs/1000)}s; check explorer. Hash: ${hash}`);
  }
  async paymentOnChain(op,cfg){
    const data=cfg.selectors.paymentOf+toWord(op.payer)+strip(op.operationId);
    return receiptFields(await this.ethCall(cfg.contractAddress,data,op.payer));
  }
  async submitArcPayment(op,cfg,{onStep=()=>{}}={}){
    if(!cfg.arcReady)throw new GhostPayError('Arc contract and merchant are not configured');
    const payer=await this.connectArc(cfg);
    if(payer!==op.payer.toLowerCase())throw new GhostPayError('Connected wallet differs from operation payer');
    onStep('Reading onchain payment receipt');
    const existing=await this.paymentOnChain(op,cfg);
    if(existing.amount>0n){
      if(existing.amount!==BigInt(op.amountUnits)||existing.requestHash.toLowerCase()!==op.requestHash.toLowerCase()||existing.merchant.toLowerCase()!==op.merchant.toLowerCase())
        throw new GhostPayError('Existing receipt is for different payment parameters');
      onStep('Payment already exists onchain. No new transaction sent.');
      return {alreadyPaid:true,txHash:null};
    }
    const allowance=await this.ethCall(cfg.usdcAddress,cfg.selectors.allowance+toWord(payer)+toWord(cfg.contractAddress),payer);
    let approvalTx=null;
    if(BigInt(allowance)<BigInt(op.amountUnits)){
      onStep('Requesting exact 0.10 USDC token approval');
      approvalTx=await this.walletRequest('eth_sendTransaction',[{
        from:payer,to:cfg.usdcAddress, value:'0x0',
        data:cfg.selectors.approve+toWord(cfg.contractAddress)+uintWord(op.amountUnits)
      }]);
      await this.waitReceipt(approvalTx);
      onStep('Token approval confirmed');
    }
    // Preflight again to avoid accidental extra submission after a long approval flow.
    const afterApproval=await this.paymentOnChain(op,cfg);
    if(afterApproval.amount>0n){onStep('Previously settled by another request; payment skipped');return {alreadyPaid:true,txHash:null,approvalTx};}
    onStep('Wallet confirms a real Arc Mainnet USDC payment');
    const txHash=await this.walletRequest('eth_sendTransaction',[{
      from:payer,to:cfg.contractAddress,value:'0x0',
      data:cfg.selectors.pay+strip(op.operationId)+toWord(op.merchant)+uintWord(op.amountUnits)+strip(op.requestHash)
    }]);
    await this.waitReceipt(txHash);
    onStep('Onchain transaction confirmed');
    return {alreadyPaid:false,txHash,approvalTx};
  }
}

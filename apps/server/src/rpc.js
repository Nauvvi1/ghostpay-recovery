import { keccak256,selector } from './keccak.js';
import { isAddress,isBytes32, CHAIN_ID,RPC_URL } from './config.js';

export const ABI = Object.freeze({
  pay: selector('pay(bytes32,address,uint256,bytes32)'),
  paymentOf:selector('paymentOf(address,bytes32)'),
  approve:selector('approve(address,uint256)'),
  allowance:selector('allowance(address,address)'),
  balanceOf:selector('balanceOf(address)'),
  usdc:selector('usdc()'),
  paidEvent:keccak256('PaymentRecorded(bytes32,address,bytes32,address,uint256,bytes32)')
});
const clean=x=>x.startsWith('0x')?x.slice(2):x;
export function wordAddress(value){if(!isAddress(value)) throw new Error('Invalid address');return clean(value.toLowerCase()).padStart(64,'0');}
export function wordBytes32(value){if(!isBytes32(value)) throw new Error('Invalid bytes32');return clean(value.toLowerCase());}
export function wordUint(value){const n=BigInt(value);if(n<0n||n>=(1n<<256n))throw new Error('Invalid uint256');return n.toString(16).padStart(64,'0');}
export function encodePaymentOf(payer,operationId){return ABI.paymentOf+wordAddress(payer)+wordBytes32(operationId);}
export function encodePay(operationId,merchant,amount,requestHash){return ABI.pay+wordBytes32(operationId)+wordAddress(merchant)+wordUint(amount)+wordBytes32(requestHash);}
export function encodeApprove(spender,amount){return ABI.approve+wordAddress(spender)+wordUint(amount);}
export function encodeAllowance(owner,spender){return ABI.allowance+wordAddress(owner)+wordAddress(spender);}
function parseWords(output){if(typeof output!=='string'||!/^0x[\da-fA-F]*$/.test(output)||output.length<2)return []; const hex=output.slice(2);if(hex.length%64)throw new Error('Malformed eth_call output');return hex.match(/.{64}/g)||[];}
export function decodeReceipt(output){
  const w=parseWords(output);
  if(w.length<4)throw new Error('Unexpected paymentOf response');
  return { merchant:'0x'+w[0].slice(24).toLowerCase(), amount:BigInt('0x'+w[1]), requestHash:'0x'+w[2].toLowerCase(), blockNumber:BigInt('0x'+w[3]) };
}
export class RpcClient {
  constructor({url=RPC_URL, chainId=CHAIN_ID, fetcher=globalThis.fetch}={}) {this.url=url;this.chainId=chainId;this.fetcher=fetcher;}
  async call(method,params){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
    try {
      const resp=await this.fetcher(this.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:controller.signal});
      if(!resp.ok)throw new Error(`RPC HTTP ${resp.status}`);
      const body=await resp.json(); if(body.error)throw new Error(`RPC ${body.error.message}`);
      if(body.result===undefined)throw new Error('RPC result missing');return body.result;
    } finally {clearTimeout(timer);}
  }
  async paymentOf(contractAddress, payer, operationId){
    if(!isAddress(contractAddress))throw new Error('Invalid contract address');
    const id=parseInt(await this.call('eth_chainId',[]),16);
    if(id!==this.chainId)throw new Error(`Wrong RPC chain ID: ${id} (expected ${this.chainId})`);
    const token=await this.call('eth_call',[{to:contractAddress,data:ABI.usdc},'latest']);
    const tokenWords=parseWords(token);
    if(tokenWords.length!==1||('0x'+tokenWords[0].slice(24).toLowerCase())!=='0x3600000000000000000000000000000000000000')
      throw new Error('Contract is not configured with canonical Arc USDC');
    const raw=await this.call('eth_call',[{to:contractAddress,data:encodePaymentOf(payer,operationId)},'latest']);
    return decodeReceipt(raw);
  }
}

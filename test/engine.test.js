import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepository } from '../apps/server/src/repository.js';
import { createApp } from '../apps/server/src/app.js';
import { keccak256, selector } from '../apps/server/src/keccak.js';
import { ABI,encodePay,encodePaymentOf,decodeReceipt,encodeAllowance,wordUint,RpcClient } from '../apps/server/src/rpc.js';
import { GhostPayClient, GhostPayError } from '../sdk/ghostpay.js';

async function fixture(mode='demo',rpc){
  const repo=openRepository(':memory:');
  const app=createApp({repo,mode,rpc,contract:'0x1111111111111111111111111111111111111111',merchant:'0x2222222222222222222222222222222222222222'});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const client=new GhostPayClient({baseUrl:url});
  return {app,client,url,close:()=>app.close()};
}

test('Keccak-256 matches Ethereum vectors and function selectors',()=>{
  assert.equal(keccak256(''),'0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc'),'0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(selector('transfer(address,uint256)'),'0xa9059cbb');
  assert.equal(ABI.allowance,'0xdd62ed3e');
  assert.equal(ABI.approve,'0x095ea7b3');
});

test('ABI encoder/decoder preserves 6-decimal USDC amounts and identity',()=>{
  const payer='0x3333333333333333333333333333333333333333';
  const op='0x'+'12'.repeat(32);const req='0x'+'a0'.repeat(32);
  assert.equal(encodePay(op,payer,100000,req).length,10+64*4);
  assert.equal(encodePaymentOf(payer,op).length,10+64*2);
  assert.equal(encodeAllowance(payer,payer).slice(0,10),'0xdd62ed3e');
  const result='0x'+payer.slice(2).padStart(64,'0')+wordUint(100000)+req.slice(2)+wordUint(984);
  assert.deepEqual(decodeReceipt(result),{merchant:payer,amount:100000n,requestHash:req,blockNumber:984n});
});

test('lost response truly closes HTTP connection, then recovers without another debit',async()=>{
  const f=await fixture();
  try{
    const created=await f.client.startDemo();
    await assert.rejects(f.client.attemptDemo(created.operationId,'lost-response'),GhostPayError);
    const afterDrop=await f.client.getOperation(created.operationId);
    assert.equal(afterDrop.status,'fulfilled');
    assert.equal(afterDrop.paymentCount,1);
    assert.equal(afterDrop.serviceExecutions,1);
    assert.ok(afterDrop.events.some(e=>e.kind==='FAULT_INJECTED'));
    for(let i=0;i<4;i++){
      const replay=await f.client.attemptDemo(created.operationId,'lost-response');
      assert.equal(replay.state.result.reportId,afterDrop.result.reportId);
    }
    const after=await f.client.getOperation(created.operationId);
    assert.equal(after.attempts,5);
    assert.equal(after.paymentCount,1);
    assert.equal(after.serviceExecutions,1);
    assert.ok(after.events.filter(e=>e.kind==='PAYMENT_REPLAY_BLOCKED').length>=4);
  }finally{await f.close();}
});

test('crash after payment recovers work in a new HTTP request',async()=>{
  const f=await fixture();
  try{
    const start=await f.client.startDemo();
    await assert.rejects(f.client.attemptDemo(start.operationId,'crash-after-payment'),e=>e.status===503);
    const paid=await f.client.getOperation(start.operationId);
    assert.equal(paid.status,'paid');assert.equal(paid.serviceExecutions,0);assert.equal(paid.paymentCount,1);
    const response=await f.client.attemptDemo(start.operationId,'crash-after-payment');
    assert.equal(response.state.status,'fulfilled');
    assert.equal(response.state.serviceExecutions,1);assert.equal(response.state.paymentCount,1);
  }finally{await f.close();}
});

test('crash after service execution restores durable output without rerunning service',async()=>{
  const f=await fixture();
  try{
    const start=await f.client.startDemo();
    await assert.rejects(f.client.attemptDemo(start.operationId,'crash-after-job'),e=>e.status===503);
    const partial=await f.client.getOperation(start.operationId);
    assert.equal(partial.status,'paid');assert.equal(partial.hasDurableJob,true);assert.equal(partial.result,null);
    const response=await f.client.attemptDemo(start.operationId,'crash-after-job');
    assert.equal(response.state.serviceExecutions,1);
    assert.equal(response.state.status,'fulfilled');
  }finally{await f.close();}
});

test('five concurrent requests settle and run a service exactly once',async()=>{
  const f=await fixture();
  try{
    const start=await f.client.startDemo();
    const replies=await Promise.all(Array.from({length:5},()=>f.client.attemptDemo(start.operationId,'concurrent')));
    assert.equal(replies.length,5);
    const op=await f.client.getOperation(start.operationId);
    assert.equal(op.attempts,5);assert.equal(op.paymentCount,1);assert.equal(op.serviceExecutions,1);
    assert.equal(op.status,'fulfilled');
  }finally{await f.close();}
});

test('SQLite persists settlement and job across repository process re-open',()=>{
  const folder=mkdtempSync(join(tmpdir(),'ghostpay-'));
  const file=join(folder,'db.sqlite');
  try{
    let repo=openRepository(file);
    const op=repo.create();repo.attempt(op.id);repo.payDemo(op.id);repo.doJob(op.id);
    const output=JSON.stringify(repo.state(op.id));
    repo.close();repo=openRepository(file);
    assert.equal(repo.state(op.id).paymentCount,1);
    assert.equal(repo.state(op.id).serviceExecutions,1);
    repo.finalize(op.id);assert.equal(repo.state(op.id).result.reportId,'RPT-'+JSON.parse(output).operationId.slice(2,10).toUpperCase());
    repo.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});

test('Arc backend checks authoritative onchain receipt and rejects mismatches',async()=>{
  let paid=false,wrong=false;
  const rpc={paymentOf:async()=>({merchant:wrong?'0x4444444444444444444444444444444444444444':'0x2222222222222222222222222222222222222222',amount:paid?100000n:0n,requestHash:operationHash,blockNumber:550n})};
  let operationHash='0x'+'ff'.repeat(32);
  const f=await fixture('arc',rpc);
  try{
    const config=await f.client.getConfig();assert.equal(config.arcReady,true);
    const payer='0x3333333333333333333333333333333333333333';
    const order=await f.client.prepareArc(payer);operationHash=order.requestHash;
    await assert.rejects(f.client.recoverArc(order.operationId),e=>e.status===409);
    paid=true;wrong=true;
    await assert.rejects(f.client.recoverArc(order.operationId),e=>e.status===409);
    wrong=false;
    const recovered=await f.client.recoverArc(order.operationId);
    assert.equal(recovered.verifiedOnchain,true);
    assert.equal(recovered.blockNumber,'550');
    assert.equal(recovered.state.paymentCount,1);
    assert.equal(recovered.state.serviceExecutions,1);
    const again=await f.client.recoverArc(order.operationId);
    assert.equal(again.state.paymentCount,1);
  }finally{await f.close();}
});

test('HTTP rejects invalid scenario and corrupted operation IDs',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(f.client.attemptDemo('123','lost-response'),e=>e.status===400);
    const op=await f.client.startDemo();
    await assert.rejects(f.client.attemptDemo(op.operationId,'hack'),e=>e.status===400);
  }finally{await f.close();}
});

test('RPC client verifies chain ID, official USDC token and decodes onchain receipt',async()=>{
  const payer='0x3333333333333333333333333333333333333333';
  const merchant='0x2222222222222222222222222222222222222222';
  const op='0x'+'ab'.repeat(32);
  const req='0x'+'cd'.repeat(32);
  let calls=[];
  const rpc=new RpcClient({url:'https://example.org/',fetcher:async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    let result;
    if(body.method==='eth_chainId')result='0x13b2';
    else if(body.params[0].data===ABI.usdc)result='0x'+'3600000000000000000000000000000000000000'.padStart(64,'0');
    else result='0x'+merchant.slice(2).padStart(64,'0')+wordUint(100000)+req.slice(2)+wordUint(8);
    return {ok:true,json:async()=>({jsonrpc:'2.0',id:1,result})};
  }});
  const receipt=await rpc.paymentOf('0x1111111111111111111111111111111111111111',payer,op);
  assert.equal(receipt.amount,100000n);assert.equal(receipt.blockNumber,8n);assert.equal(calls.length,3);
});

test('EIP-1193 SDK skips all sending when this operation already settled onchain',async()=>{
  const payer='0x3333333333333333333333333333333333333333';
  const merchant='0x2222222222222222222222222222222222222222';
  const op={payer,merchant,operationId:'0x'+'ab'.repeat(32),requestHash:'0x'+'cd'.repeat(32),amountUnits:100000};
  const cfg={arcReady:true,chainId:5042,contractAddress:'0x1111111111111111111111111111111111111111',usdcAddress:'0x3600000000000000000000000000000000000000',merchantAddress:merchant,selectors:ABI,explorer:'https://explorer.arc.io',rpcUrl:'https://rpc.mainnet.arc.io'};
  let transactions=0;
  const ethereum={request:async({method,params})=>{
    if(method==='eth_requestAccounts')return [payer];
    if(method==='eth_chainId')return '0x13b2';
    if(method==='eth_call')return '0x'+merchant.slice(2).padStart(64,'0')+wordUint(100000)+op.requestHash.slice(2)+wordUint(90);
    if(method==='eth_sendTransaction'){transactions++;throw new Error('SHOULD NEVER SEND');}
    throw new Error('Unexpected wallet method: '+method);
  }};
  const client=new GhostPayClient({ethereum});
  const result=await client.submitArcPayment(op,cfg);
  assert.equal(result.alreadyPaid,true);assert.equal(transactions,0);
});

test('EIP-1193 SDK asks exact allowance and submits one payment for a new operation',async()=>{
  const payer='0x3333333333333333333333333333333333333333';
  const merchant='0x2222222222222222222222222222222222222222';
  const op={payer,merchant,operationId:'0x'+'ab'.repeat(32),requestHash:'0x'+'cd'.repeat(32),amountUnits:100000};
  const cfg={arcReady:true,chainId:5042,contractAddress:'0x1111111111111111111111111111111111111111',usdcAddress:'0x3600000000000000000000000000000000000000',merchantAddress:merchant,selectors:ABI,explorer:'https://explorer.arc.io',rpcUrl:'https://rpc.mainnet.arc.io'};
  const sent=[];
  const ethereum={request:async({method,params})=>{
    if(method==='eth_requestAccounts')return [payer];
    if(method==='eth_chainId')return '0x13b2';
    if(method==='eth_call'){
      const requestData=params[0].data;
      if(requestData.startsWith(ABI.allowance))return '0x'+wordUint(0);
      if(requestData.startsWith(ABI.paymentOf))return '0x'+wordUint(0).repeat(4);
      throw new Error('Unknown call');
    }
    if(method==='eth_sendTransaction'){
      sent.push(params[0]);return '0x'+String(sent.length).padStart(64,'0');
    }
    if(method==='eth_getTransactionReceipt')return {status:'0x1'};
    throw new Error('Unexpected method: '+method);
  }};
  const client=new GhostPayClient({ethereum});
  const result=await client.submitArcPayment(op,cfg);
  assert.equal(result.alreadyPaid,false);
  assert.equal(sent.length,2);
  assert.equal(sent[0].to,cfg.usdcAddress);
  assert.equal(sent[0].data,ABI.approve+cfg.contractAddress.slice(2).padStart(64,'0')+wordUint(100000));
  assert.equal(sent[1].to,cfg.contractAddress);
  assert.equal(sent[1].data,encodePay(op.operationId,merchant,100000,op.requestHash));
});

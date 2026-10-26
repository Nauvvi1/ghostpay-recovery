import { GhostPayClient } from '/sdk/ghostpay.js';
const $=id=>document.getElementById(id);
const client=new GhostPayClient();
let config=null, activeOperation=null, currentTab='demo', wallet=null, busy=false;
const sleep=t=>new Promise(r=>setTimeout(r,t));
const compact=id=>id?.length>22?`${id.slice(0,16)}…${id.slice(-12)}`:id;
const safe=(value)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function setBusy(value){
  busy=value;
  $('runDemo').disabled=value;
  $('connectWallet').disabled=value;
  $('createArc').disabled=value||!wallet;
  $('payArc').disabled=value||!activeOperation||activeOperation.mode!=='arc';
  $('recoverArc').disabled=value||!activeOperation||activeOperation.mode!=='arc';
  $('demoTab').disabled=value;$('arcTab').disabled=value;
  $('runDemo').innerHTML=value?'⟳ &nbsp; Running recovery scenario…':'<span>▶</span> Simulate failure &amp; recover <span class="button-arrow">↗</span>';
}
function info(message,kind='info'){
  const line=$('operationFoot');line.textContent=message;
  line.style.color=kind==='error'?'#f1a4ae':kind==='good'?'#82edc1':'#9ab0b5';
}
function showTab(tab){
  currentTab=tab;
  $('demoPanel').hidden=tab!=='demo'; $('arcPanel').hidden=tab!=='arc';
  $('demoTab').classList.toggle('active',tab==='demo');$('arcTab').classList.toggle('active',tab==='arc');
  $('arcMissing').hidden=Boolean(config?.arcReady);$('arcReady').hidden=!config?.arcReady;
  if(tab==='arc'&&!config?.arcReady)info('On-chain mode requires PAYMENT_MODE=arc plus ARC_CONTRACT_ADDRESS and MERCHANT_ADDRESS. Arc Testnet contract is deployed; demo mode is always available.');
}
function eventStyle(kind){
  if(/FAULT|CRASH/.test(kind))return 'negative';
  if(/PAID|VERIFIED|RECOVERED|REUSED|BLOCKED|REPLAY/.test(kind))return 'positive';
  return '';
}
function render(op){
  activeOperation=op;
  const hasPayment=op.paymentCount>0,hasJob=op.hasDurableJob,finished=op.status==='fulfilled';
  $('operationId').textContent=compact(op.operationId);$('operationId').title=op.operationId;
  $('copyId').disabled=false;
  $('operationStatus').className='status-label '+(finished?'paid':hasPayment?'paid':'idle');
  $('operationStatus').textContent=finished?'✓ RECOVERED':hasPayment?'SETTLED':'CREATED';
  for(const [name,done] of [['flowCreated',true],['flowPaid',hasPayment],['flowJob',hasJob],['flowResult',finished]])$(name).classList.toggle('done',done);
  $('paidAmount').textContent=hasPayment?op.amountUSDC:'0.00';
  $('retryCount').textContent=Math.max(0,op.attempts-1);
  $('extraDebits').textContent='0';
  $('kpiPayments').textContent=op.paymentCount;
  $('kpiRetries').textContent=Math.max(0,op.attempts-1);
  $('kpiJobs').textContent=op.serviceExecutions;
  $('kpiDuplicates').textContent=op.paymentCount>1?op.paymentCount-1:0;
  if(op.result){
    const modeLabel=op.mode==='arc'?'ON-CHAIN RESULT RECOVERED':'SIMULATED RESULT RECOVERED';
    $('outputBox').innerHTML=`<div class="result-title">✓ ${modeLabel}</div>
    <div class="result-row">Report <strong>${safe(op.result.reportId)}</strong>${op.mode==='demo'?' <span class="result-note">(illustrative)</span>':''}</div>
    <div class="result-row">Risk score <strong>${safe(op.result.riskScore)} / 100</strong>${op.mode==='demo'?' <span class="result-note">(illustrative)</span>':''}</div>
    <div class="result-row">Confidence <strong>${safe(Math.round(op.result.confidence*100))}%</strong>${op.mode==='demo'?' <span class="result-note">(illustrative)</span>':''}</div>
    <div class="result-row">Status <strong>One service execution · one payment</strong></div>`;
  }else if(hasJob){
    $('outputBox').innerHTML='<span class="output-placeholder">◷ &nbsp; Service output is persisted; response not yet finalized. A retry will recover it.</span>';
  }else if(hasPayment){
    $('outputBox').innerHTML='<span class="output-placeholder">◷ &nbsp; Payment exists; service result will be produced on the next retry.</span>';
  }else {
    $('outputBox').innerHTML='<span class="output-placeholder">◷ &nbsp; Operation created. Awaiting USDC settlement.</span>';
  }
  const events=op.events||[];
  $('eventCount').textContent=`${events.length} EVENT${events.length===1?'':'S'}`;
  $('eventList').innerHTML=events.length?events.map(e=>`<div class="event ${eventStyle(e.kind)}"><span class="event-point"></span><span class="event-time">${safe((e.created_at||'').slice(11,23))}</span><span class="event-kind">${safe(e.kind.replaceAll('_',' '))}</span><span class="event-detail">${safe(e.detail)}</span></div>`).join(''):'<div class="empty-events">No events.</div>';
  const txHash=op.txHash||localStorage.getItem('ghostpay:tx:'+op.operationId);
  const link=$('txLink');
  if(op.mode==='arc'&&txHash&&/^0x[0-9a-fA-F]{64}$/.test(txHash)&&config){
    link.href=config.explorer+'/tx/'+txHash;link.hidden=false;
  }else{link.hidden=true;}
  localStorage.setItem('ghostpay:last-operation',op.operationId);
  setBusy(busy);
}
async function refreshOperation(id){
  const op=await client.getOperation(id);
  render(op);return op;
}
async function startDemo(){
  if(busy)return;
  const scenario=document.querySelector('input[name="scenario"]:checked')?.value||'lost-response';
  setBusy(true);info('Creating a fresh operation ID…');
  try{
    const created=await client.startDemo();render(created);
    const id=created.operationId;
    if(scenario==='concurrent'){
      info('Dispatching five simultaneous HTTP requests with the SAME operationId');
      await Promise.all(Array.from({length:5},()=>client.attemptDemo(id,scenario)));
      await refreshOperation(id);
      info('Five concurrent calls completed. One payment row; one service execution.', 'good');
    }else{
      for(let i=0;i<5;i++){
        info(`Attempt ${i+1}/5 · ${i===0?'injecting fault':'replaying original operation'}…`);
        try{await client.attemptDemo(id,scenario);}catch(error){
          info(`Attempt ${i+1}: ${error.message}. Recovery will retry with the SAME operation ID.`,'error');
        }
        await refreshOperation(id);
        await sleep(350);
      }
      info('Recovered the original result. Payment count = 1, even after 5 attempts.','good');
    }
    $('eventList').scrollTop=0;
  }catch(error){info(error.message,'error');}
  finally{setBusy(false);}
}
async function connectWallet(){
  if(busy)return;setBusy(true);
  try{wallet=await client.connectArc(config);$('walletLine').textContent=wallet;info('Wallet connected. Prepare an operation to obtain an immutable ID.','good');}
  catch(error){info(error.message,'error');}
  finally{setBusy(false);}
}
async function prepareArc(){
  if(!wallet||busy)return;setBusy(true);
  try{const op=await client.prepareArc(wallet);render(op);info('Prepared 0.10 USDC operation. Payment requires wallet approval.','good');}
  catch(error){info(error.message,'error');}
  finally{setBusy(false);}
}
async function payArc(){
  if(!activeOperation||activeOperation.mode!=='arc'||busy)return;setBusy(true);
  const op=activeOperation;
  try{
    const result=await client.submitArcPayment(op,config,{onStep:message=>info(message)});
    if(result.txHash){
      const url=config.explorer+'/tx/'+encodeURIComponent(result.txHash);
      localStorage.setItem('ghostpay:tx:'+op.operationId,result.txHash);
      info(`Arc transaction confirmed: ${result.txHash}. Recovering paid response…`,'good');
      console.info('GhostPay mainnet tx',url);
    }
    const recovery=await client.recoverArc(op.operationId);
    render(recovery.state);info('Verified by Arc onchain state; original paid API response recovered.','good');
  }catch(error){info(`Payment or recovery interrupted: ${error.message}. Use "Recover from Arc" — do not pay again.`,'error');}
  finally{setBusy(false);}
}
async function recoverArc(){
  if(!activeOperation||activeOperation.mode!=='arc'||busy)return;setBusy(true);
  try{const result=await client.recoverArc(activeOperation.operationId);render(result.state);info('Recovered from onchain payment receipt without submitting any new transfer.','good');}
  catch(error){info(error.message,'error');try{await refreshOperation(activeOperation.operationId);}catch{}}
  finally{setBusy(false);}
}
async function boot(){
  for(const option of document.querySelectorAll('.scenario-option input'))option.addEventListener('change',()=>{
    document.querySelectorAll('.scenario-option').forEach(label=>label.classList.toggle('selected',label.querySelector('input').checked));
  });
  $('runDemo').addEventListener('click',startDemo);
  $('demoTab').addEventListener('click',()=>showTab('demo'));
  $('arcTab').addEventListener('click',()=>showTab('arc'));
  $('connectWallet').addEventListener('click',connectWallet);
  $('createArc').addEventListener('click',prepareArc);
  $('payArc').addEventListener('click',payArc);
  $('recoverArc').addEventListener('click',recoverArc);
  $('copyId').addEventListener('click',async()=>{if(!activeOperation)return;try{await navigator.clipboard.writeText(activeOperation.operationId);info('Operation ID copied.','good');}catch{info('Clipboard unavailable; full ID is shown on hover.','error');}});
  try{
    config=await client.getConfig();
    $('networkName').textContent=config.mode==='arc'?'ARC · LIVE':'DEMO SIMULATION';
    $('serverStatus').textContent='Recovery engine online';
    showTab(config.mode==='arc'?'arc':'demo');
    if(config.mode==='arc'&&!config.arcReady)info('Arc mode selected but contract and merchant have not been configured.','error');
    const previous=localStorage.getItem('ghostpay:last-operation');
    if(previous){try{await refreshOperation(previous);}catch{localStorage.removeItem('ghostpay:last-operation');}}
  }catch(error){$('serverStatus').textContent='Engine unreachable';info(`Cannot reach backend: ${error.message}`,'error');}
}
boot();

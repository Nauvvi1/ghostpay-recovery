import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { openRepository } from './repository.js';
import { ABI, RpcClient } from './rpc.js';
import { DB_FILE, PAYMENT_MODE, CONTRACT_ADDRESS, MERCHANT_ADDRESS, PRICE_UNITS, USDC_ADDRESS, CHAIN_ID, RPC_URL, isAddress, isBytes32 } from './config.js';

const PUBLIC=resolve(dirname(fileURLToPath(import.meta.url)),'../../web');
const SDK_FILE=resolve(dirname(fileURLToPath(import.meta.url)),'../../../sdk/ghostpay.js');
const FILE_TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const SCENARIOS=new Set(['normal','lost-response','crash-after-payment','crash-after-job','concurrent']);
const NO_CACHE={'cache-control':'no-store','x-content-type-options':'nosniff'};

// ---------------------------------------------------------------------------
// CORS — allowlist-based, NOT reflected.
//
// Allowed origins:
//   1. Any *.preview.studio.arc.io subdomain  — Arc Studio workbench preview.
//   2. null / undefined (same-origin or local file)  — local dev / Docker.
//   3. GHOSTPAY_ALLOWED_ORIGIN env var  — optional extra origin for self-hosted
//      deployments (e.g. "https://ghostpay.example.com"). Leave unset unless
//      you are hosting the frontend on a separate domain from the API.
//
// Requests from any other Origin receive no ACAO header; the browser will block
// the cross-origin request as intended.
//
// NOTE: GhostPay's /api/* endpoints are not authenticated — they do not hold
// any secrets and carry only operation IDs. Even so, reflecting an arbitrary
// Origin would allow any site to issue demo/start or demo/attempt calls on
// behalf of a visiting user's browser, which is unnecessary.
// ---------------------------------------------------------------------------
const EXTRA_ORIGIN = process.env.GHOSTPAY_ALLOWED_ORIGIN || '';
function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / no Origin header
  if (/^https:\/\/[a-z0-9-]+\.preview\.studio\.arc\.io$/.test(origin)) return true;
  if (EXTRA_ORIGIN && origin === EXTRA_ORIGIN) return true;
  // Allow localhost and 127.0.0.1 on any port for local development.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}
function applyCors(req, res) {
  const origin = req.headers['origin'];
  if (isAllowedOrigin(origin)) {
    if (origin) res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('vary', 'Origin');
  }
  // No ACAO header for disallowed origins — browser blocks the request.
}

function json(res,status,body){res.writeHead(status,{...NO_CACHE,'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));}
function error(res,status,message){json(res,status,{error:message});}
async function bodyJson(req){
  let total=0; const chunks=[];
  for await(const chunk of req){total+=chunk.length;if(total>8192)throw Object.assign(new Error('Request body too large'),{httpStatus:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
  catch{throw Object.assign(new Error('Invalid JSON'),{httpStatus:400});}
}
function publicState(repo,id){return repo.state(id);}
export function createApp({repo=openRepository(DB_FILE),rpc=new RpcClient(),mode=PAYMENT_MODE,contract=CONTRACT_ADDRESS,merchant=MERCHANT_ADDRESS}={}){
  const mainnetReady=mode==='arc'&&isAddress(contract)&&isAddress(merchant)&&contract.toLowerCase()!==USDC_ADDRESS;
  async function handle(req,res){
    const url=new URL(req.url||'/', 'http://localhost');
    const path=url.pathname;
    // CORS: allowlist check + preflight response before any routing.
    applyCors(req, res);
    if(req.method==='OPTIONS'){res.writeHead(204,{'content-length':'0'});res.end();return;}
    if(req.method==='GET'&&path==='/api/config')return json(res,200,{
      mode,arcReady:mainnetReady,chainId:CHAIN_ID,rpcUrl:RPC_URL,contractAddress:mainnetReady?contract:null,
      merchantAddress:mainnetReady?merchant:null,usdcAddress:USDC_ADDRESS,amountUnits:PRICE_UNITS,amountUSDC:'0.10',selectors:ABI,
      explorer:'https://explorer.arc.io', scenarios:[...SCENARIOS]
    });
    if(req.method==='GET'&&path==='/api/health')return json(res,200,{ok:true,mode});
    if(req.method==='GET'&&path==='/api/stats')return json(res,200,repo.stats());
    const stateMatch=path.match(/^\/api\/operations\/(0x[0-9a-fA-F]{64})$/);
    if(req.method==='GET'&&stateMatch){const state=publicState(repo,stateMatch[1].toLowerCase());return state?json(res,200,state):error(res,404,'Operation not found');}
    if(req.method==='POST'&&path==='/api/demo/start'){
      if(mode==='arc')return error(res,403,'Demo endpoints disabled in Arc payment mode');
      return json(res,201,publicState(repo,repo.create({mode:'demo'}).id));
    }
    if(req.method==='POST'&&path==='/api/demo/attempt'){
      if(mode==='arc')return error(res,403,'Demo endpoints disabled in Arc payment mode');
      const body=await bodyJson(req);
      if(!isBytes32(body.operationId)||!SCENARIOS.has(body.scenario))return error(res,400,'Invalid operationId or scenario');
      const id=body.operationId.toLowerCase();
      const op=repo.attempt(id);if(!op||op.mode!=='demo')return error(res,404,'Demo operation not found');
      repo.payDemo(id);
      if(body.scenario==='crash-after-payment'&&repo.markFault(id,'Simulated process crash after payment persistence, before service execution')){
        return json(res,503,{error:'Simulated worker crash after payment; retry using same operationId',state:publicState(repo,id)});
      }
      repo.doJob(id);
      if(body.scenario==='crash-after-job'&&repo.markFault(id,'Simulated process crash after durable service output, before response finalization')){
        return json(res,503,{error:'Simulated crash after service completion; retry to recover result',state:publicState(repo,id)});
      }
      repo.finalize(id);
      if(body.scenario==='lost-response'&&repo.markFault(id,'Real TCP connection closed after payment and result committed')){
        // Intentionally destroy the TCP connection. The wallet never gets a response,
        // even though payment and API result already exist durably in SQLite.
        res.destroy();
        return;
      }
      return json(res,200,{recovered:true,state:publicState(repo,id)});
    }
    if(req.method==='POST'&&path==='/api/arc/prepare'){
      if(!mainnetReady)return error(res,503,'Arc mode not configured. Set PAYMENT_MODE=arc, ARC_CONTRACT_ADDRESS and MERCHANT_ADDRESS');
      const body=await bodyJson(req);
      if(!isAddress(body.payer))return error(res,400,'Invalid payer address');
      return json(res,201,publicState(repo,repo.create({mode:'arc',payer:body.payer,merchant,amount:PRICE_UNITS}).id));
    }
    if(req.method==='POST'&&path==='/api/arc/recover'){
      if(!mainnetReady)return error(res,503,'Arc mode not configured');
      const body=await bodyJson(req);
      if(!isBytes32(body.operationId))return error(res,400,'Invalid operation ID');
      const id=body.operationId.toLowerCase();const op=repo.get(id);
      if(!op||op.mode!=='arc')return error(res,404,'Arc operation not found');
      repo.attempt(id);
      // The onchain operation is the source of truth, not a browser-supplied tx hash.
      // This works even when the original transaction response was lost completely.
      const receipt=await rpc.paymentOf(contract,op.payer,id);
      if(receipt.amount===0n)return json(res,409,{error:'No Arc settlement recorded for this operation yet',state:publicState(repo,id)});
      if(receipt.amount!==BigInt(op.amount)||receipt.merchant!==op.merchant||receipt.requestHash!==op.request_hash)
        return error(res,409,'Onchain payment exists but does not match committed operation parameters');
      repo.confirmArc(id);
      repo.doJob(id);
      repo.finalize(id);
      return json(res,200,{recovered:true,verifiedOnchain:true,blockNumber:receipt.blockNumber.toString(),state:publicState(repo,id)});
    }
    if(req.method==='GET'&&path==='/sdk/ghostpay.js'){
      const source=await readFile(SDK_FILE);res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache'});res.end(source);return;
    }
    if(req.method==='GET'&& !path.startsWith('/api/')) {
      // /lab and /lab/ both serve the Failure Lab dashboard.
      // / serves the new landing page (index.html).
      let relative=path==='/'?'index.html':path==='/lab'||path==='/lab/'?'lab.html':decodeURIComponent(path.slice(1));
      const filepath=resolve(PUBLIC,relative);
      if(!filepath.startsWith(PUBLIC+sep)&&filepath!==PUBLIC)return error(res,403,'Forbidden');
      if(!FILE_TYPES[extname(filepath)])return error(res,404,'Not found');
      try{
        const data=await readFile(filepath);
        res.writeHead(200,{'content-type':FILE_TYPES[extname(filepath)],'x-content-type-options':'nosniff','cache-control':'no-cache',
          // frame-ancestors omitted — Arc Studio preview iframes the page from *.preview.studio.arc.io.
          // connect-src allows same-origin API + Arc RPC endpoints used by the EIP-1193 SDK in Arc mode.
          // arc-studio-allow-onchain-literal (CSP header value, not RPC call code)
          // style-src allows fonts.googleapis.com for the landing page font stylesheet.
          // font-src allows fonts.gstatic.com for the actual font files.
          'content-security-policy':"default-src 'self'; img-src 'self' data:; connect-src 'self' https://rpc.testnet.arc.io https://rpc.mainnet.arc.io; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; object-src 'none'; base-uri 'self'"});res.end(data);return;
      }catch{return error(res,404,'Not found');}
    }
    return error(res,404,'Route not found');
  }
  const server=createServer((req,res)=>{Promise.resolve(handle(req,res)).catch(err=>{
    console.error('[GhostPay]',err.message);
    if(!res.headersSent&&!res.destroyed)error(res,err.httpStatus||500,err.httpStatus?err.message:'Internal error');
  });});
  return {server,repo,close:()=>new Promise((resolve,reject)=>server.close(e=>{repo.close();e?reject(e):resolve();}))};
}

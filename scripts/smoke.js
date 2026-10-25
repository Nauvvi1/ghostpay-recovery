import assert from 'node:assert/strict';
import {createApp} from '../apps/server/src/app.js';
import {openRepository} from '../apps/server/src/repository.js';
import {GhostPayClient} from '../sdk/ghostpay.js';
const app=createApp({repo:openRepository(':memory:'),mode:'demo'});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const client=new GhostPayClient({baseUrl:`http://127.0.0.1:${app.server.address().port}`});
try{
  const config=await client.getConfig();assert.equal(config.mode,'demo');
  const start=await client.startDemo();
  try{await client.attemptDemo(start.operationId,'lost-response');}catch{}
  const recovered=await client.attemptDemo(start.operationId,'lost-response');
  assert.equal(recovered.state.paymentCount,1);
  assert.equal(recovered.state.serviceExecutions,1);
  assert.equal(recovered.state.status,'fulfilled');
  const frontend=await fetch(`http://127.0.0.1:${app.server.address().port}/`);
  assert.ok(frontend.ok);
  console.log('PASS: HTTP UI, dropped TCP response, one settlement, one service execution, recovered response.');
}finally{await app.close();}

import { createApp } from './app.js';
const host=process.env.HOST || '127.0.0.1';
const port=Number(process.env.PORT || 4173);
const app=createApp();
app.server.listen(port,host,()=>{
  console.log(`\n👻 GhostPay Recovery Engine — http://${host}:${port}`);
  console.log(`Mode: ${process.env.PAYMENT_MODE || 'demo'} | Node ${process.versions.node}\n`);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.server.close(()=>{app.repo.close();process.exit(0);}));

'use strict';
// Local driver for the compiled test-only Flutter app; all signaling uses the SDK.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {observe, until} = require('./rust-av-live.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
async function main() {
  const directory = path.resolve(process.env.VDON_FLUTTER_WEB || 'build-interop/flutter/web');
  const types = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json'};
  const server = http.createServer((req,res)=>{
    const file=path.resolve(directory,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));
    if(!file.startsWith(directory+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser=await chromium.launch({headless:true,handleSIGINT:false,handleSIGTERM:false,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage();
    let stopped=false;
    page.on('console',m=>{console.log(m.text());if(m.text()==='STOPPED')stopped=true;});
    page.on('pageerror',e=>console.error(e));
    await page.addInitScript(observe);
    const url=new URL(`http://127.0.0.1:${server.address().port}/`);
    for(const [key,value] of Object.entries(process.env))if(key.startsWith('VDO_'))url.searchParams.set(key,value);
    const shutdown=new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
    await page.goto(url.href);
    await until(async()=>{
      const stats=await page.evaluate(async()=> (await Promise.all(avPeerConnections.map(async pc=>[...(await pc.getStats()).values()]))).flat());
      const video=stats.find(v=>v.type==='inbound-rtp'&&v.kind==='video'&&v.framesDecoded>=100);
      const audio=stats.find(v=>v.type==='inbound-rtp'&&v.kind==='audio'&&v.totalSamplesReceived>=48000&&v.totalAudioEnergy>0);
      if(video&&audio){
        fs.writeFileSync(path.join(process.env.VDO_OUT,'received-stats.json'),JSON.stringify(stats,null,2));
        console.log('RX video 100\nRX audio 100');return true;
      }
      return false;
    },'Flutter did not decode incoming A/V',90000);
    await shutdown;
    await page.evaluate(()=>stopPeer());
    await until(()=>stopped,'Flutter shutdown failed',15000);
  } finally {await browser?.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

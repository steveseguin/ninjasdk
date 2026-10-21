'use strict';
// Test-only peers: VDO_NATIVE_PORT=python|go|c|flutter|kotlin|swift|rust-data. No SDK/page handlers are replaced.
const assert = require('node:assert/strict');
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {observe, stats, until, dataFirst, signalingObserver, nativeControl} = require('./rust-av-live.cjs');
const root = path.resolve(__dirname, '../..');
const port = process.env.VDO_NATIVE_PORT || 'python';
const dataOnly = port === 'rust-data';
const host = process.env.VDO_SIGNAL_URL || 'wss://wss.vdo.ninja';
const target = process.env.VDO_TEST_URL || 'https://vdo.ninja/';
const salt = process.env.VDO_TEST_SALT || 'vdo.ninja';
const timeout = Number(process.env.VDO_TEST_TIMEOUT_MS || 60000);
async function udpPort() {
  const socket=require('node:dgram').createSocket('udp4');
  await new Promise(r=>socket.bind(0,'127.0.0.1',r));
  const port=socket.address().port; await new Promise(r=>socket.close(r)); return port;
}

async function main() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `ninjasdk-${port}-web-`));
  const token = 'web' + port.replace(/[^a-z]/g,'') + Date.now().toString(36);
  const password = 'web café & literal%20secret';
  const media = path.join(out, 'test.mkv');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','5','-c:v','libvpx','-deadline','realtime','-g','30','-c:a','libopus','-ac','2',media]);
  for (const [kind, ext] of [['v','ivf'], ['a','ogg']]) {
    execFileSync('ffmpeg',['-v','error','-i',media,'-map',`0:${kind}`,'-c','copy', ...(kind==='a'?['-page_duration','20000']:[]),media+'.'+ext]);
  }
  console.log('Testing '+port+' against '+target+'; artifacts: '+out);
  const signaling = await signalingObserver(password, token, token+'out', token+'in');
  const env = {...process.env, VDO_HOST:signaling.host, VDO_PASSWORD:password, VDO_SALT:salt,
    VDO_ROOM:token, VDO_PUBLISH:token+'out', VDO_VIEW:token+'in', VDO_OUT:out, VDO_MEDIA:media};
  const auxiliary=[];
  const ffmpeg = (name,args) => {
    const child=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',d=>fs.appendFileSync(path.join(out,name+'.log'),d));
    const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    auxiliary.push({child,exit}); return child;
  };
  if(port==='c') {
    env.VDO_RX_AUDIO=String(await udpPort());env.VDO_RX_VIDEO=String(await udpPort());

  }
  const commands = {
    python:[process.env.VDON_PYTHON || 'python3', path.join(root,'python/tests/browser_peer.py')],
    go:[process.env.VDON_GO_BROWSER_PEER || path.join(root,'build-interop/go-browser-peer')],
    'rust-data':[process.env.VDON_RUST_DATA_PEER || path.join(root,'rust/target/debug/examples/browser-data-test')],
    swift:[process.env.VDON_SWIFT_BROWSER_PEER || path.join(root,'swift/.build/debug/BrowserPeer')],
    kotlin:[process.execPath, path.join(__dirname,'android-peer.cjs')],
    flutter:[process.execPath, path.join(__dirname,'flutter-peer.cjs')],
    c:[process.env.VDON_C_BROWSER_PEER || path.join(root,'c/build/vdon_browser_peer')],
  };
  assert(commands[port], 'unsupported port: '+port);
  let log='', exited=false, browser;
  const peer = spawn(commands[port][0],commands[port].slice(1),{env,stdio:['ignore','pipe','pipe']});
  const capture = data => { log += data; fs.appendFileSync(path.join(out,'peer.log'),data); };
  peer.stdout.on('data',capture); peer.stderr.on('data',capture);
  const exit = new Promise(resolve => {
    peer.once('error',error=>{exited=true;capture(error.message);resolve({code:-1});});
    peer.once('exit',(code,signal)=>{exited=true;capture(`\nEXIT code=${code} signal=${signal}\n`);resolve({code,signal});});
  });
  try {
    await until(()=>{assert(!exited,log); return log.includes('READY');},'peer startup failed');
    console.log(port+': peer ready');
    if(port==='c') {
      const [,video,audio]=log.match(/UDP video=(\d+) audio=(\d+)/);
      ffmpeg('producer',['-v','warning','-re','-stream_loop','-1','-i',media,
        '-map','0:v','-c','copy','-f','rtp','-payload_type','96','-ssrc','1234',`rtp://127.0.0.1:${video}?pkt_size=1200`,
        '-map','0:a','-c','copy','-f','rtp','-payload_type','111','-ssrc','1235',`rtp://127.0.0.1:${audio}?pkt_size=1200`]);
    }
    browser = await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
    const viewer=await browser.newPage(), publisher=await browser.newPage();
    for (const page of [viewer,publisher]) await page.addInitScript(observe);
    function url(role,id) {
      const u=new URL(target);
      const params={ [role]:id,room:token,wss2:host,salt,password:encodeURIComponent(password),
        ...(role==='view'?{scene:'0'}:{codec:'vp8',webcam:'1',view:'',autostart:'1',...(port==='kotlin'?{width:'320',height:'240',fps:'10'}:{})}) };
      for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);
      return u.href;
    }
    await Promise.all([viewer.goto(url('view',token+'out'),{waitUntil:'domcontentloaded'}),publisher.goto(url('push',token+'in'),{waitUntil:'domcontentloaded'})]);
    if (!dataOnly) await until(async()=>{
      assert(!exited,log);
      const s=await stats(viewer,'rpcs');
      return s.some(v=>v.kind==='video'&&v.framesDecoded>30)&&s.some(v=>v.kind==='audio'&&v.totalSamplesReceived>48000&&v.totalAudioEnergy>0);
    },port+' outbound A/V not decoded',timeout);
    console.log(port+': browser received media / control channel');
    if (!dataOnly) await until(()=>log.includes('RX audio 100')&&log.includes('RX video 100'),port+' did not receive both media kinds',timeout);
    if (port === 'c') {
      const videoPT = log.match(/CODEC video PT=(\d+)/)[1];
      const audioPT = log.match(/CODEC audio PT=(\d+)/)[1];
      const sdp=path.join(out,'receive.sdp');
      fs.writeFileSync(sdp,`v=0\no=- 0 0 IN IP4 127.0.0.1\ns=SDK test\nc=IN IP4 127.0.0.1\nt=0 0\nm=video ${env.VDO_RX_VIDEO} RTP/AVP ${videoPT}\na=rtpmap:${videoPT} VP8/90000\nm=audio ${env.VDO_RX_AUDIO} RTP/AVP ${audioPT}\na=rtpmap:${audioPT} opus/48000/2\n`);
      ffmpeg('receiver',['-v','warning','-protocol_whitelist','file,udp,rtp','-analyzeduration','2000000','-i',sdp,'-map','0:v','-map','0:a','-c','copy',path.join(out,'received.mkv')]);
      await new Promise(r=>setTimeout(r,8000));
    }
    if (!dataOnly) {
      for(const page of [viewer,publisher]) {
        const wire=await page.evaluate(()=>avWire);
        wire.dc.forEach(nativeControl);
      }
      dataFirst(await viewer.evaluate(()=>avWire),signaling.decrypt,token+'out');
      dataFirst(await publisher.evaluate(()=>avWire),signaling.decrypt,token+'in','out');
    }
    // Explicit application probes on each existing media connection, in both directions.
    for (const [page,group,channel] of [[viewer,'rpcs','receiveChannel'],[publisher,'pcs','sendChannel']]) {
      await until(()=>page.evaluate(({group,channel})=>Object.values(session[group]).some(pc=>pc[channel]?.readyState==='open'),{group,channel}),'control channel did not open',timeout);
      const probe=token+group;
      await page.evaluate(({group,channel,probe})=>{
        const pc=Object.values(session[group]).find(pc=>pc[channel]?.readyState==='open');
        pc[channel].send(JSON.stringify({pipe:probe}));
      },{group,channel,probe});
      await until(()=>page.evaluate(probe=>avWire.dc.some(m=>m.value.pipe===probe),probe),'application data echo missing on '+group);
      const s=await stats(page,group);
      assert(s.some(v=>v.type==='transport'&&v.dtlsState==='connected'&&(dataOnly||v.srtpCipher)),'missing DTLS/SRTP');
    }
    console.log(port+': media and data checks passed; disconnecting');
    peer.kill('SIGINT');
    await until(()=>exited,'native shutdown failed',port==='kotlin'?60000:15000);
    assert.deepEqual(await exit,{code:0,signal:null},log);
    assert(log.includes('STOPPED'),log);
    for(const {child} of auxiliary)child.kill('SIGINT');
    for(const {child,exit} of auxiliary) {
      let completed=false; exit.then(()=>{completed=true;});
      await until(()=>completed,'FFmpeg failed to finalize recordings',20000).catch(error=>{child.kill('SIGKILL');throw error;});
      assert.equal((await exit).signal,null,'FFmpeg was killed before finalizing');
    }
    for(const page of [viewer,publisher])await until(()=>page.evaluate(()=>avWire.dc.some(m=>m.value.bye===true)),'native bye missing');
    assert.deepEqual(signaling.errors.map(e=>e.message),[]);
    const recordings=fs.readdirSync(out).filter(f=>f.startsWith('received.')&&/\.(mkv|webm|ivf|ogg|wav|ppm)$/.test(f));
    if(['flutter','kotlin','swift'].includes(port)) assert(fs.existsSync(path.join(out,'received-stats.json')));
    else if (!dataOnly) assert(recordings.length,'no recordings');
    for(const file of recordings) {
      const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',path.join(out,file)]));
      assert(probe.streams.length && probe.streams.every(s=>Number(s.nb_read_frames)>0),'empty recorded media: '+file);
      execFileSync('ffmpeg',['-v','error','-xerror','-i',path.join(out,file),'-f','null','-']);
    }
    const container=recordings.find(f=>/\.(mkv|webm)$/.test(f));
    if(container){
      const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',path.join(out,container)]));
      assert.deepEqual(probe.streams.map(s=>s.codec_type).sort(),['audio','video']);
    }else if(port==='python') assert(recordings.includes('received.ppm')&&recordings.includes('received.wav'));
    else if(!dataOnly&&!['flutter','kotlin','swift'].includes(port)) assert(recordings.some(f=>f.endsWith('.ivf'))&&recordings.some(f=>f.endsWith('.ogg')));
    console.log('PASS '+port+': '+(dataOnly?'': 'decoded A/V both ways, ')+'application data both peer roles, native signaling, bye.');
    console.log('Target: '+target+'\nArtifacts: '+out);
  } catch(error) {
    console.error(log);
    console.error('Signaling errors:', signaling.errors.map(e=>e.message));
    fs.writeFileSync(path.join(out,'signaling.json'),JSON.stringify(signaling.messages,null,2));
    if(browser)for(const [i,page] of browser.contexts().flatMap(c=>c.pages()).entries()) {
      fs.writeFileSync(path.join(out,`failure-${i}.json`),JSON.stringify({wire:await page.evaluate(()=>window.avWire),rpcs:await stats(page,'rpcs'),pcs:await stats(page,'pcs')},null,2));
    }
    console.error('Failure artifacts: '+out);
    throw error;
  } finally {
    if(!exited){peer.kill('SIGTERM');await Promise.race([exit,new Promise(r=>setTimeout(r,10000))]);if(!exited)peer.kill('SIGKILL');}
    // A failed simulator wrapper can leave a child holding inherited stdout open.
    peer.stdout.destroy(); peer.stderr.destroy();
    await browser?.close(); await signaling.close();
    for(const {child} of auxiliary)if(child.exitCode===null)child.kill('SIGKILL');
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});

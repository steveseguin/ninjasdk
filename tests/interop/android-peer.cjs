'use strict';
// Test-only ADB driver. Requires a booted emulator/device and the browser-test APK.
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {until}=require('./rust-av-live.cjs');
const adb=process.env.VDON_ADB||'adb';
const serial=process.env.ANDROID_SERIAL;
const prefix=serial?['-s',serial]:[];
const command=args=>execFileSync(adb,[...prefix,...args],{encoding:'utf8'});
const quote=text=>"'"+text.replace(/'/g,"'\\''")+"'";
async function main(){
  const app='ninja.vdo.browsertest';
  command(['shell','am','force-stop',app]);
  command(['logcat','-c']);
  const log=spawn(adb,[...prefix,'logcat','-v','raw','VdoBrowserTest:I','AndroidRuntime:E','*:S']);
  let output='';
  log.stdout.on('data',d=>{output+=d;process.stdout.write(d);});
  log.stderr.on('data',d=>process.stderr.write(d));
  const shutdown=new Promise(r=>{process.once('SIGINT',r);process.once('SIGTERM',r);});
  try{
    let shell=`am start -n ${app}/.MainActivity`;
    for(const key of ['VDO_HOST','VDO_PASSWORD','VDO_SALT','VDO_ROOM','VDO_PUBLISH','VDO_VIEW']){
      const value=key==='VDO_HOST'?process.env[key].replace('127.0.0.1','10.0.2.2'):process.env[key];
      shell+=` --es ${key} ${quote(value)}`;
    }
    command(['shell',shell]);
    await shutdown;
    command(['shell','am','broadcast','-a',app+'.STOP','-p',app]);
    await until(()=>output.includes('STOPPED'),'Android shutdown failed',20000);
    fs.writeFileSync(path.join(process.env.VDO_OUT,'received-stats.json'),JSON.stringify({decodedVideo:output.includes('RX video 100'),decodedAudio:output.includes('RX audio 100')}));
  } finally {log.kill();command(['shell','am','force-stop',app]);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

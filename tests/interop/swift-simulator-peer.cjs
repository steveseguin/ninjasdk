#!/usr/bin/env node
'use strict';
// Forward only the test fixture environment to an iOS simulator process.
const {spawn,execFileSync}=require('node:child_process');
const env={...process.env};
for(const [key,value] of Object.entries(process.env))if(key.startsWith('VDO_'))env['SIMCTL_CHILD_'+key]=value;
const device=process.env.VDON_SWIFT_SIMULATOR_DEVICE;
const child=spawn('xcrun',['simctl','spawn',device,process.env.VDON_SWIFT_SIMULATOR_BINARY],{env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  execFileSync('xcrun',['simctl','spawn',device,'killall','-INT','BrowserPeer']);
});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});

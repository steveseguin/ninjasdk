#!/usr/bin/env node
'use strict';
// Forward only the test fixture environment to an iOS simulator process.
const {spawn}=require('node:child_process');
const env={...process.env};
for(const [key,value] of Object.entries(process.env))if(key.startsWith('VDO_'))env['SIMCTL_CHILD_'+key]=value;
const device=process.env.VDON_SWIFT_SIMULATOR_DEVICE;
const child=spawn('xcrun',['simctl','spawn',device,process.env.VDON_SWIFT_SIMULATOR_BINARY],{env,stdio:['ignore','pipe','pipe']});
let nativePID, output='';
child.stdout.on('data',data=>{
  output+=data;
  const pid=output.match(/^PID (\d+)$/m);
  if(pid)nativePID=Number(pid[1]);
  process.stdout.write(data);
});
child.stderr.on('data',data=>process.stderr.write(data));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  // Simulator processes share the host PID namespace; signal only this fixture.
  if(nativePID)process.kill(nativePID,'SIGINT');
  else child.kill('SIGINT');
});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});

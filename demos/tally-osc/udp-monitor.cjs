'use strict';
// Test receiver for this sample's OSC boolean/integer packets. Use a spare port, not VRChat's port.
const socket = require('node:dgram').createSocket('udp4');
const port = Number(process.argv[2] || 9002);
socket.on('error', error => { console.error(error.message); socket.close(); process.exitCode = 1; });
socket.on('message', packet => {
  const end = packet.indexOf(0);
  if (end < 0) return;
  const typeOffset = Math.ceil((end + 1) / 4) * 4;
  const type = packet.toString('utf8', typeOffset, typeOffset + 2);
  if (type === ',T' || type === ',F') console.log(packet.toString('utf8', 0, end), type === ',T');
  else if (type === ',i' && packet.length >= typeOffset + 8) console.log(packet.toString('utf8', 0, end), packet.readInt32BE(typeOffset + 4));
});
socket.bind(port, '127.0.0.1', () => console.log('Listening for OSC on 127.0.0.1:' + port));

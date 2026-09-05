'use strict';
const WebSocket = require('ws');
const crypto = require('node:crypto');

async function connectOBS(url, password) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let counter = 0;
  const ready = new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.op === 0) {
        const data = { rpcVersion: 1, eventSubscriptions: 0 };
        if (message.d.authentication) {
          const { salt, challenge } = message.d.authentication;
          const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
          data.authentication = crypto.createHash('sha256').update(secret + challenge).digest('base64');
        }
        socket.send(JSON.stringify({ op: 1, d: data }));
      } else if (message.op === 2) resolve();
      else if (message.op === 7) {
        const task = pending.get(message.d.requestId);
        if (!task) return;
        clearTimeout(task.timer);
        pending.delete(message.d.requestId);
        if (message.d.requestStatus.result) task.resolve(message.d.responseData || {});
        else task.reject(new Error(JSON.stringify(message.d.requestStatus)));
      }
    });
  });
  await ready;
  return {
    request(requestType, requestData = {}) {
      return new Promise((resolve, reject) => {
        const requestId = String(++counter);
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('OBS request timeout: ' + requestType)); }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      });
    },
    close() { socket.close(); }
  };
}
module.exports = { connectOBS };

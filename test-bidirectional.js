
const wrtc = require('@roamhq/wrtc');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk.js');

// Polyfills for Node.js
global.WebSocket = WebSocket;
global.crypto = crypto.webcrypto || crypto;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) {
        super(type, options);
        this.detail = options?.detail;
    }
};
global.btoa = (str) => Buffer.from(str).toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString();

const TEST_ROOM = 'local-bidir-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
const PUB_STREAM = 'pub-' + Math.random().toString(36).substr(2, 9);
let pubRecv = false, viewRecv = false;

async function test() {
    try {
        const publisher = new VDONinjaSDK();
        const viewer = new VDONinjaSDK();
        
        publisher.addEventListener('dataReceived', (e) => {
            console.log('  ✓ Publisher received:', e.detail.data);
            pubRecv = true;
        });
        
        viewer.addEventListener('dataReceived', (e) => {
            console.log('  ✓ Viewer received:', e.detail.data);
            viewRecv = true;
        });
        
        await publisher.connect();
        await publisher.joinRoom({ room: TEST_ROOM });
        await publisher.announce({ streamID: 'pub-stream' });
        
        await viewer.connect();
        await viewer.joinRoom({ room: TEST_ROOM });
        await viewer.view('pub-stream');
        
        await new Promise(r => setTimeout(r, 2000));
        
        publisher.sendData({ from: 'publisher', test: 1 });
        viewer.sendData({ from: 'viewer', test: 2 });
        
        await new Promise(r => setTimeout(r, 3000));
        
        if (pubRecv && viewRecv) {
            console.log('  ✓ Bidirectional communication works');
            publisher.disconnect();
            viewer.disconnect();
            process.exit(0);
        } else {
            throw new Error(`Bidirectional failed: pub=${pubRecv}, view=${viewRecv}`);
        }
    } catch (error) {
        console.error('  ✗ Bidirectional test failed:', error.message);
        process.exit(1);
    }
}
test();
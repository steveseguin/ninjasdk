
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

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';

const TEST_ROOM = 'local-dup-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
        const PEER1_STREAM = 'p1-' + Math.random().toString(36).substr(2, 9);
        const PEER2_STREAM = 'p2-' + Math.random().toString(36).substr(2, 9);
        let messagesReceived = [];
        let PEER2_UUID = null;
        const DP_DEBUG = !!process.env.DP_DEBUG && process.env.DP_DEBUG !== '0';
        const dp = (...args) => { if (DP_DEBUG) console.log(...args); };

async function test() {
    try {
        const peer1 = new VDONinjaSDK({ host: WSS });
        const peer2 = new VDONinjaSDK({ host: WSS });
        
        // Capture peer2's UUID from peer1's perspective
        peer1.addEventListener('peerConnected', (e) => {
            dp('[DP] peer1 peerConnected:', e.detail?.uuid, e.detail?.connection?.type);
            if (!PEER2_UUID && e?.detail?.uuid) {
                PEER2_UUID = e.detail.uuid;
            }
        });
        peer2.addEventListener('peerConnected', (e) => {
            dp('[DP] peer2 peerConnected:', e.detail?.uuid, e.detail?.connection?.type);
        });

        for (const sdk of [peer1, peer2]) {
            sdk.addEventListener('dataChannelOpen', (e) => dp('[DP] dataChannelOpen', sdk===peer1?'peer1':'peer2', e.detail));
            sdk.addEventListener('listing', (e) => dp('[DP] listing', sdk===peer1?'peer1':'peer2', e.detail?.streamID || '(list)'));
            sdk.addEventListener('videoaddedtoroom', (e) => dp('[DP] videoadded', sdk===peer1?'peer1':'peer2', e.detail.streamID, e.detail.uuid));
            sdk.addEventListener('streamAdded', (e) => dp('[DP] streamAdded', sdk===peer1?'peer1':'peer2', e.detail.streamID, e.detail.uuid));
            sdk.addEventListener('error', (e) => dp('[DP] error', sdk===peer1?'peer1':'peer2', e.detail));
            sdk.addEventListener('alert', (e) => dp('[DP] alert', sdk===peer1?'peer1':'peer2', e.detail));
        }

        peer2.addEventListener('dataReceived', (e) => {
            const d = e.detail?.data;
            if (d && d.test === 'no-duplicate' && d.id === 1) {
                messagesReceived.push(d);
                dp('[DP] peer2 counted dataReceived. total=', messagesReceived.length);
            } else {
                dp('[DP] peer2 ignored dataReceived:', d);
            }
        });
        
        // Both announce and view each other (dual connection)
        dp('[DP] peer1.connect');
        await peer1.connect();
        dp('[DP] peer1.joinRoom');
        await peer1.joinRoom({ room: TEST_ROOM });
        dp('[DP] peer1.announce');
        await peer1.announce({ streamID: PEER1_STREAM });
        dp('[DP] peer2.connect');
        await peer2.connect();
        dp('[DP] peer2.joinRoom');
        await peer2.joinRoom({ room: TEST_ROOM });
        dp('[DP] peer2.announce');
        await peer2.announce({ streamID: PEER2_STREAM });
        
        await new Promise(r => setTimeout(r, 1000));
        dp('[DP] peer1.view(PEER2_STREAM)');
        await peer1.view(PEER2_STREAM);
        dp('[DP] peer2.view(PEER1_STREAM)');
        await peer2.view(PEER1_STREAM);

        // Wait for a data channel to open between peers (robust across Node versions)
        async function waitForOpenDC(sdk, uuid, timeoutMs = 15000) {
            const start = Date.now();
            return new Promise((resolve) => {
                const check = () => {
                    try {
                        // Inspect any open DC to that UUID
                        for (const [id, conns] of sdk.connections || []) {
                            if (uuid && id !== uuid) continue;
                            for (const t of ['publisher','viewer']) {
                                const c = conns[t];
                                if (c && c.dataChannel && c.dataChannel.readyState === 'open') {
                                    return resolve(true);
                                }
                            }
                        }
                    } catch (e) {}
                    if (Date.now() - start >= timeoutMs) return resolve(false);
                    setTimeout(check, 200);
                };
                // Also resolve on dataChannelOpen just in case
                const onOpen = (e) => {
                    if (!uuid || e.detail?.uuid === uuid) {
                        resolve(true);
                    }
                };
                try { sdk.addEventListener('dataChannelOpen', onOpen); } catch (e) {}
                check();
            });
        }

        // If we already know peer2 UUID, wait for DC open; otherwise continue and rely on retries
        if (PEER2_UUID) {
            const ok = await waitForOpenDC(peer1, PEER2_UUID, 15000);
            dp('[DP] waitForOpenDC result:', ok);
        }
        // Retry sending until the SDK confirms sent (up to 12s)
        const payload = { test: 'no-duplicate', id: 1 };
        let sent = false;
        let attempts = 0;
        const deadline = Date.now() + 20000; // allow more time on slower setups (Node 18 + wrtc)
        while (!sent && Date.now() < deadline) {
            attempts++;
            if (PEER2_UUID) {
                sent = peer1.sendData(payload, PEER2_UUID);
                dp('[DP] send attempt', attempts, '(uuid)', PEER2_UUID, 'sent=', sent);
            } else {
                sent = peer1.sendData(payload, { streamID: PEER2_STREAM, type: 'viewer' });
                dp('[DP] send attempt', attempts, '(streamID viewer)', PEER2_STREAM, 'sent=', sent);
            }
            if (!sent) {
                try {
                    const list1 = [];
                    for (const [uuid, conns] of peer1.connections || []) {
                        for (const t of ['publisher','viewer']) {
                            const c = conns[t];
                            if (c) list1.push({ uuid: c.uuid, type: c.type, streamID: c.streamID, dc: c.dataChannel?.readyState, ice: c.pc?.iceConnectionState });
                        }
                    }
                    dp('[DP] peer1 connections:', list1);
                    const list2 = [];
                    for (const [uuid, conns] of peer2.connections || []) {
                        for (const t of ['publisher','viewer']) {
                            const c = conns[t];
                            if (c) list2.push({ uuid: c.uuid, type: c.type, streamID: c.streamID, dc: c.dataChannel?.readyState, ice: c.pc?.iceConnectionState });
                        }
                    }
                    dp('[DP] peer2 connections:', list2);
                    try {
                        const v1 = peer1._getConnections ? peer1._getConnections({ streamID: PEER2_STREAM, type: 'viewer' }) : [];
                        const p1 = peer1._getConnections ? peer1._getConnections({ streamID: PEER2_STREAM, type: 'publisher' }) : [];
                        dp('[DP] peer1 _getConnections viewer count:', v1.length, 'publisher count:', p1.length);
                    } catch (e2) {}
                } catch (e) {}
                await new Promise(r => setTimeout(r, 300));
            }
        }

        dp('[DP] after send attempts, sent=', sent);
        if (!sent) {
            dp('[DP] state: p1.connected=', peer1.state.connected, 'p2.connected=', peer2.state.connected);
            throw new Error('Failed to send test message after retries');
        }
        
        await new Promise(r => setTimeout(r, 5000));
        console.log("6");
        if (messagesReceived.length === 1) {
            console.log('  ✓ No duplicates with dual connections');
            peer1.disconnect();
            peer2.disconnect();
            process.exit(0);
        } else {
            throw new Error(`Expected 1 message, got ${messagesReceived.length}`);
        }
    } catch (error) {
        console.error('  ✗ Duplicate prevention test failed:', error.message);
        process.exit(1);
    }
}
test();
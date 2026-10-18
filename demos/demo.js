/**
 * VDO.Ninja SDK Demo - Two-Peer P2P Messaging (landing page)
 *
 * This demo is MIT licensed; see LICENSE-DEMOS.
 *
 * Note: The VDO.Ninja SDK core (`vdoninja-sdk.js`, `vdoninja-sdk.min.js`) is
 * separately licensed under MPL-2.0; see LICENSE.
 *
 * Two independent SDK instances run in this page. Each one calls autoConnect()
 * on the same private room, which connects to the handshake server, joins the
 * room, announces a data-only stream, and opens a data channel to the other peer.
 */

const peers = {
    1: { vdo: null, isConnected: false, connecting: false, streamID: null, openChannels: new Set() },
    2: { vdo: null, isConnected: false, connecting: false, streamID: null, openChannels: new Set() }
};

// A random room per page load keeps visitors from landing in each other's demo.
const demoRoom = 'sdkdemo_' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');

const progress = { sent: false, received: false };

document.addEventListener('DOMContentLoaded', () => {
    const roomNameEl = document.getElementById('demoRoomName');
    if (roomNameEl) roomNameEl.textContent = demoRoom;

    for (const peerId of [1, 2]) {
        const input = document.getElementById(`peer${peerId}Input`);
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') sendPeerMessage(peerId);
            });
        }
        updatePeerStatus(peerId);
    }
});

async function togglePeer(peerId) {
    const peer = peers[peerId];
    if (peer.connecting) return;
    if (peer.isConnected || peer.vdo) {
        await disconnectPeer(peerId);
    } else {
        await connectPeer(peerId);
    }
}

async function toggleBothPeers() {
    const anyActive = Object.values(peers).some(peer => peer.vdo || peer.connecting);
    if (anyActive) {
        await Promise.all([disconnectPeer(1), disconnectPeer(2)]);
        return;
    }
    // Connect one after the other so the second peer finds the first in the room listing.
    await connectPeer(1);
    await connectPeer(2);
}

async function connectPeer(peerId) {
    const peer = peers[peerId];
    if (peer.vdo || peer.connecting) return;

    peer.connecting = true;
    peer.openChannels.clear();
    updatePeerStatus(peerId);

    const vdo = new VDONinjaSDK();
    peer.vdo = vdo;

    vdo.addEventListener('dataReceived', (event) => {
        const { data, uuid } = event.detail;
        displayPeerMessage(peerId, data, uuid, 'received');
    });

    vdo.addEventListener('dataChannelOpen', (event) => {
        peer.openChannels.add(event.detail.uuid);
        logEvent(peerId, `Data channel open with ${shortId(event.detail.uuid)}`, 'success');
        updatePeerStatus(peerId);
    });

    vdo.addEventListener('dataChannelClose', (event) => {
        peer.openChannels.delete(event.detail.uuid);
        logEvent(peerId, `Data channel closed with ${shortId(event.detail.uuid)}`, 'warning');
        updatePeerStatus(peerId);
    });

    vdo.addEventListener('peerConnected', (event) => {
        logEvent(peerId, `WebRTC connection established with ${shortId(event.detail.uuid)}`, 'info');
    });

    vdo.addEventListener('peerDisconnected', (event) => {
        peer.openChannels.delete(event.detail.uuid);
        logEvent(peerId, `Peer ${shortId(event.detail.uuid)} left`, 'warning');
        updatePeerStatus(peerId);
    });

    try {
        logEvent(peerId, `autoConnect({ room: '${demoRoom}' })`, 'system');
        const { streamID } = await vdo.autoConnect({ room: demoRoom, label: `Peer ${peerId}` });
        if (peer.vdo !== vdo) return; // Disconnected while connecting
        peer.streamID = streamID;
        peer.isConnected = true;
        logEvent(peerId, `Joined the room and announced as ${streamID}`, 'info');
    } catch (error) {
        // Ignore failures caused by the user disconnecting mid-connect.
        if (peer.vdo === vdo) {
            console.error(`Peer ${peerId} connection failed:`, error);
            logEvent(peerId, `Connection failed: ${error.message}`, 'error');
            peer.vdo = null;
            try { await vdo.disconnect(); } catch (e) { /* already closed */ }
        }
    } finally {
        if (peer.vdo === vdo || !peer.vdo) peer.connecting = false;
        updatePeerStatus(peerId);
    }
}

async function disconnectPeer(peerId) {
    const peer = peers[peerId];
    const vdo = peer.vdo;
    peer.vdo = null;
    peer.isConnected = false;
    peer.connecting = false;
    peer.streamID = null;
    peer.openChannels.clear();
    updatePeerStatus(peerId);
    if (vdo) {
        try { await vdo.disconnect(); } catch (e) { /* already closed */ }
        logEvent(peerId, 'Disconnected', 'system');
    }
    clearPeerMessages(peerId);
}

function updatePeerStatus(peerId) {
    const peer = peers[peerId];
    const statusEl = document.getElementById(`peer${peerId}Status`);
    const connectBtn = document.getElementById(`peer${peerId}ConnectBtn`);
    const messageInput = document.getElementById(`peer${peerId}Input`);
    const sendBtn = document.getElementById(`peer${peerId}SendBtn`);
    const streamIdEl = document.getElementById(`peer${peerId}StreamID`);
    if (!statusEl || !connectBtn) return;

    const ready = peer.isConnected && peer.openChannels.size > 0;
    let state = 'idle';
    let label = 'Not connected';
    if (peer.connecting) {
        state = 'connecting';
        label = 'Connecting…';
    } else if (ready) {
        state = 'live';
        label = 'Ready to chat';
    } else if (peer.isConnected) {
        state = 'waiting';
        label = 'Waiting for the other peer';
    }
    statusEl.dataset.state = state;
    statusEl.textContent = label;

    connectBtn.textContent = peer.vdo ? 'Disconnect' : 'Connect';
    connectBtn.classList.toggle('btn-primary', !peer.vdo);
    connectBtn.classList.toggle('btn-secondary', !!peer.vdo);
    connectBtn.disabled = peer.connecting;

    messageInput.disabled = !ready;
    sendBtn.disabled = !ready;
    messageInput.placeholder = ready ? `Message from Peer ${peerId}…` : 'Connect both peers to chat';
    if (streamIdEl) streamIdEl.textContent = peer.streamID || '—';

    updateConnectionInfo();
}

function sendPeerMessage(peerId) {
    const peer = peers[peerId];
    const input = document.getElementById(`peer${peerId}Input`);
    const message = input.value.trim();

    if (!message || !peer.vdo || !peer.isConnected) return;

    const sent = peer.vdo.sendData({
        message: message,
        from: `Peer ${peerId}`,
        timestamp: Date.now()
    });

    if (!sent) {
        logEvent(peerId, 'Message not sent: no open data channel yet. Wait for the other peer and try again.', 'error');
        return;
    }

    displayPeerMessage(peerId, { message: message }, 'You', 'sent');
    progress.sent = true;
    updateConnectionInfo();

    input.value = '';
    input.focus();
}

// Renders a chat message. Message text and sender names can come from an
// untrusted peer, so everything is written with textContent, never as HTML.
function displayPeerMessage(peerId, data, sender, type = 'received') {
    const messageArea = document.getElementById(`peer${peerId}Messages`);
    if (!messageArea) return;
    const empty = messageArea.querySelector('.chat-empty');
    if (empty) empty.remove();

    let content;
    if (data && typeof data === 'object' && data.message !== undefined) {
        content = String(data.message);
    } else if (typeof data === 'string') {
        content = data;
    } else {
        content = JSON.stringify(data);
    }

    let senderName = sender;
    if (type === 'received') {
        senderName = (data && typeof data.from === 'string' && data.from) ? data.from : shortId(sender);
    }

    const messageEl = document.createElement('div');
    messageEl.className = 'msg' + (type === 'sent' ? ' self' : '');

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const senderEl = document.createElement('span');
    senderEl.className = 'msg-sender';
    senderEl.textContent = senderName;
    const timeEl = document.createElement('span');
    timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    meta.append(senderEl, timeEl);

    const body = document.createElement('div');
    body.className = 'msg-body message-content';
    body.textContent = content;

    messageEl.append(meta, body);
    messageArea.appendChild(messageEl);
    messageArea.scrollTop = messageArea.scrollHeight;

    if (type === 'received') {
        progress.received = true;
        updateConnectionInfo();
    }
}

function clearPeerMessages(peerId) {
    const messageArea = document.getElementById(`peer${peerId}Messages`);
    if (!messageArea) return;
    messageArea.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'Messages will appear here';
    messageArea.appendChild(empty);
}

// Connection events go to one shared log so the chat stays readable.
function logEvent(peerId, text, type = 'system') {
    const logEl = document.getElementById('demoLog');
    if (!logEl) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + type;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date().toLocaleTimeString();
    const body = document.createElement('span');
    body.textContent = `Peer ${peerId}: ${text}`;
    entry.append(time, body);
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
}

function shortId(id) {
    return typeof id === 'string' && id ? id.substring(0, 8) : 'unknown';
}

function updateConnectionInfo() {
    const info = document.getElementById('connectionInfo');
    const bothBtn = document.getElementById('connectBothBtn');
    const connected = [1, 2].filter(id => peers[id].isConnected).length;
    const ready = [1, 2].every(id => peers[id].isConnected && peers[id].openChannels.size > 0);
    const busy = [1, 2].some(id => peers[id].connecting);

    if (info) {
        if (ready) info.textContent = 'Both peers are connected directly. Send a message from either side.';
        else if (busy) info.textContent = 'Connecting through the handshake server…';
        else if (connected) info.textContent = 'Waiting for the other peer to connect.';
        else info.textContent = 'Connect both peers to start.';
    }

    if (bothBtn) {
        const anyActive = Object.values(peers).some(peer => peer.vdo || peer.connecting);
        bothBtn.textContent = anyActive ? 'Disconnect both' : 'Connect both peers';
        bothBtn.classList.toggle('btn-primary', !anyActive);
        bothBtn.classList.toggle('btn-secondary', anyActive);
        bothBtn.disabled = busy;
    }

    const steps = [ready, progress.sent && ready, progress.received && ready];
    steps.forEach((done, index) => {
        const step = document.getElementById(`demoStep${index + 1}`);
        if (step) step.classList.toggle('done', done);
    });
}

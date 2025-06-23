/**
 * VDO.Ninja SDK Demo - Two-Peer P2P Messaging
 * 
 * This demo code is released into the public domain (CC0 1.0 Universal).
 * You may use, modify, and distribute this demo code without any restrictions.
 * 
 * Note: The VDO.Ninja SDK itself (vdoninja-sdk.js) remains licensed under AGPL-3.0.
 * See: https://github.com/steveseguin/ninjasdk/blob/main/LICENSE
 */

// Live demo functionality with two peers
let peers = {
    1: { vdo: null, isConnected: false, streamID: null, viewingStreamID: null },
    2: { vdo: null, isConnected: false, streamID: null, viewingStreamID: null }
};

let demoRoom = null;

// Initialize demo room name
document.addEventListener('DOMContentLoaded', () => {
    // Generate random room name for this demo session
    const randomSuffix = Math.floor(Math.random() * 10000);
    demoRoom = `demo-p2p-${randomSuffix}`;
    const roomNameEl = document.getElementById('demoRoomName');
    if (roomNameEl) {
        roomNameEl.textContent = demoRoom;
    }
    
    // Handle enter key for both peer inputs
    const peer1Input = document.getElementById('peer1Input');
    const peer2Input = document.getElementById('peer2Input');
    
    if (peer1Input) {
        peer1Input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendPeerMessage(1);
        });
    }
    if (peer2Input) {
        peer2Input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendPeerMessage(2);
        });
    }
});

async function togglePeer(peerId) {
    if (peers[peerId].isConnected) {
        disconnectPeer(peerId);
    } else {
        await connectPeer(peerId);
    }
}

async function connectPeer(peerId) {
    try {
        const peer = peers[peerId];
        
        // Update UI
        document.getElementById(`peer${peerId}Status`).classList.add('connecting');
        document.getElementById(`peer${peerId}StatusText`).textContent = 'Connecting...';
        document.getElementById(`peer${peerId}ConnectBtn`).disabled = true;

        // Initialize SDK
        peer.vdo = new VDONinjaSDK();
        // Use underscore instead of dash to avoid sanitization
        peer.streamID = `peer${peerId}_${Math.floor(Math.random() * 1000)}`;

        // Set up event handlers
        // Try both data and dataReceived events for compatibility
        peer.vdo.addEventListener('dataReceived', (event) => {
            const { data, uuid } = event.detail;
            displayPeerMessage(peerId, data, uuid, 'received');
        });
        
        peer.vdo.addEventListener('data', (event) => {
            const { data, uuid } = event.detail;
            console.log(`Peer ${peerId} received data event:`, event.detail);
            displayPeerMessage(peerId, data, uuid, 'received');
        });

        peer.vdo.addEventListener('peerConnected', (event) => {
            const { uuid } = event.detail;
            displayPeerMessage(peerId, { message: `Peer connected: ${uuid.substring(0, 8)}` }, 'System', 'info');
            updateConnectionInfo();
        });

        peer.vdo.addEventListener('peerDisconnected', (event) => {
            const { uuid } = event.detail;
            displayPeerMessage(peerId, { message: `Peer disconnected: ${uuid.substring(0, 8)}` }, 'System', 'info');
            updateConnectionInfo();
        });
        
        peer.vdo.addEventListener('dataChannelOpen', (event) => {
            const { uuid } = event.detail;
            displayPeerMessage(peerId, { message: `✅ Data channel opened with: ${uuid.substring(0, 8)}` }, 'System', 'success');
        });
        
        peer.vdo.addEventListener('dataChannelClose', (event) => {
            const { uuid } = event.detail;
            displayPeerMessage(peerId, { message: `❌ Data channel closed with: ${uuid.substring(0, 8)}` }, 'System', 'error');
        });

        // Listen for new streams being announced
        peer.vdo.addEventListener('listing', async (event) => {
            const detail = event.detail;
            
            // Skip if this is a list event (not individual stream)
            if (detail.list && !detail.streamID) {
                return;
            }
            
            const streamID = detail.streamID;
            const uuid = detail.uuid;
            
            // Skip if no valid streamID
            if (!streamID || streamID === 'undefined') {
                return;
            }
            
            // Don't try to view our own stream
            if (streamID === peer.streamID) {
                return;
            }
            
            // If we're not already viewing this stream, try to view it
            if (peer.viewingStreamID !== streamID) {
                try {
                    displayPeerMessage(peerId, { message: `New stream detected: ${streamID} (uuid: ${uuid ? uuid.substring(0, 8) : 'unknown'})` }, 'System', 'info');
                    
                    // Use quickView with dataOnly flag like the other demos
                    await peer.vdo.quickView({
                        streamID: streamID,
                        dataOnly: true
                    });
                    
                    peer.viewingStreamID = streamID;
                    displayPeerMessage(peerId, { message: `Successfully viewing: ${streamID}` }, 'System', 'success');
                    
                    // Update the UI to show which stream we're viewing
                    document.getElementById(`peer${peerId}Viewing`).textContent = streamID;
                } catch (err) {
                    displayPeerMessage(peerId, { error: `Failed to view ${streamID}: ${err.message}` }, 'System', 'error');
                }
            }
        });

        // Connect to server
        await peer.vdo.connect();
        
        // Join room
        await peer.vdo.joinRoom({
            room: demoRoom,
            password: 'demo123'
        });
        
        // Announce as data-only peer
        await peer.vdo.announce({
            streamID: peer.streamID
        });

        peer.isConnected = true;
        updatePeerStatus(peerId, true);
        
        // Update UI with stream ID
        document.getElementById(`peer${peerId}StreamID`).textContent = peer.streamID;
        
        displayPeerMessage(peerId, { message: `Announced as ${peer.streamID}` }, 'System', 'info');

    } catch (error) {
        console.error(`Peer ${peerId} connection failed:`, error);
        displayPeerMessage(peerId, { error: 'Connection failed: ' + error.message }, 'system', 'error');
        updatePeerStatus(peerId, false);
    }
}

function disconnectPeer(peerId) {
    const peer = peers[peerId];
    if (peer.vdo) {
        peer.vdo.disconnect();
        peer.vdo = null;
    }
    peer.isConnected = false;
    peer.streamID = null;
    peer.viewingStreamID = null;
    updatePeerStatus(peerId, false);
    clearPeerMessages(peerId);
    
    // Clear UI info
    document.getElementById(`peer${peerId}StreamID`).textContent = '-';
    document.getElementById(`peer${peerId}Viewing`).textContent = '-';
}

function updatePeerStatus(peerId, connected) {
    const statusEl = document.getElementById(`peer${peerId}Status`);
    const textEl = document.getElementById(`peer${peerId}StatusText`);
    const connectBtn = document.getElementById(`peer${peerId}ConnectBtn`);
    const messageInput = document.getElementById(`peer${peerId}Input`);
    const sendBtn = document.getElementById(`peer${peerId}SendBtn`);
    const messageContainer = document.getElementById(`peer${peerId}MessageContainer`);

    if (connected) {
        statusEl.classList.remove('connecting');
        statusEl.classList.add('connected');
        textEl.textContent = 'Connected';
        connectBtn.textContent = 'Disconnect';
        connectBtn.classList.remove('btn-primary');
        connectBtn.classList.add('btn-secondary');
        messageInput.disabled = false;
        sendBtn.disabled = false;
        messageContainer.style.display = 'block';
    } else {
        statusEl.classList.remove('connecting', 'connected');
        textEl.textContent = 'Not connected';
        connectBtn.textContent = 'Connect';
        connectBtn.classList.remove('btn-secondary');
        connectBtn.classList.add('btn-primary');
        messageInput.disabled = true;
        sendBtn.disabled = true;
        messageContainer.style.display = 'none';
    }
    
    connectBtn.disabled = false;
    updateConnectionInfo();
}

function sendPeerMessage(peerId) {
    const peer = peers[peerId];
    const input = document.getElementById(`peer${peerId}Input`);
    const message = input.value.trim();
    
    if (!message || !peer.vdo || !peer.isConnected) return;

    // Send the message
    peer.vdo.sendData({ 
        message: message, 
        from: `Peer ${peerId}`,
        timestamp: Date.now() 
    });
    
    // Display it locally
    displayPeerMessage(peerId, { message: message }, 'You', 'sent');
    
    // Clear input
    input.value = '';
    input.focus();
}

function displayPeerMessage(peerId, data, sender, type = 'received') {
    const messageArea = document.getElementById(`peer${peerId}Messages`);
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;
    
    const time = new Date().toLocaleTimeString();
    
    // Handle different message types
    let content = '';
    if (data.error) {
        content = data.error;
        sender = 'System';
    } else if (data.message) {
        content = data.message;
        if (type === 'received' && data.from) {
            sender = data.from;
        } else if (type === 'received') {
            sender = sender ? sender.substring(0, 8) : 'Unknown';
        }
    } else {
        content = JSON.stringify(data);
    }
    
    messageEl.innerHTML = `
        <div class="message-header">
            <span class="message-sender">${sender}</span>
            <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${content}</div>
    `;
    
    messageArea.appendChild(messageEl);
    messageArea.scrollTop = messageArea.scrollHeight;
}

function clearPeerMessages(peerId) {
    document.getElementById(`peer${peerId}Messages`).innerHTML = '';
}

function updateConnectionInfo() {
    const info = document.getElementById('connectionInfo');
    const peer1Connected = peers[1].isConnected;
    const peer2Connected = peers[2].isConnected;
    
    if (peer1Connected && peer2Connected) {
        info.textContent = '🟢 Both peers connected - P2P messaging active!';
        info.style.color = '#10b981';
    } else if (peer1Connected || peer2Connected) {
        info.textContent = '🟡 Waiting for the other peer to connect...';
        info.style.color = '#f59e0b';
    } else {
        info.textContent = 'Connect both peers to start chatting';
        info.style.color = '#94a3b8';
    }
}
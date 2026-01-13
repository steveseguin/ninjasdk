// SPDX-License-Identifier: MIT
// WHEP Client v1.0.0
// WebRTC-HTTP Egress Protocol client for consuming media streams
// Part of the VDO.Ninja SDK project - https://github.com/steveseguin/ninjasdk
// See LICENSE-MIT for details.

// CustomEvent polyfill for Node.js (native in Node 19+, browsers have it)
if (typeof CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.detail = options.detail || null;
        }
    };
}

/**
 * WHEPClient - Consume media streams from WHEP-compatible endpoints
 *
 * WHEP (WebRTC-HTTP Egress Protocol) is an IETF standard for consuming
 * media from WebRTC-based platforms using simple HTTP signaling.
 *
 * Compatible endpoints include:
 * - Cloudflare Stream
 * - Meshcast.io
 * - Dolby.io
 * - Any WHEP-compliant media server
 *
 * @example
 * const client = new WHEPClient('https://example.com/whep/stream123');
 * client.addEventListener('track', (e) => {
 *     video.srcObject = e.detail.streams[0];
 * });
 * await client.view();
 * // Later...
 * await client.stop();
 */
class WHEPClient extends EventTarget {
    /**
     * Create a new WHEP client
     * @param {string} endpoint - The WHEP endpoint URL
     * @param {Object} [options] - Configuration options
     * @param {string} [options.authToken] - Bearer token for authentication
     * @param {Object} [options.headers] - Additional HTTP headers
     * @param {RTCConfiguration} [options.iceServers] - Custom ICE servers
     * @param {boolean} [options.audio=true] - Request audio track
     * @param {boolean} [options.video=true] - Request video track
     * @param {boolean} [options.trickleIce=true] - Enable trickle ICE
     * @param {boolean} [options.debug=false] - Enable debug logging
     */
    constructor(endpoint, options = {}) {
        super();

        if (!endpoint) {
            throw new Error('WHEP endpoint URL is required');
        }

        this.endpoint = endpoint;
        this.options = {
            authToken: null,
            headers: {},
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun.cloudflare.com:3478' }
            ],
            audio: true,
            video: true,
            trickleIce: true,
            debug: false,
            ...options
        };

        this.pc = null;
        this.resourceUrl = null;
        this.etag = null;
        this.state = 'idle'; // idle, connecting, connected, disconnected, error
        this._pendingCandidates = [];
        this._candidateTimer = null;
        this._stream = null;
    }

    /**
     * Log debug messages
     * @private
     */
    _log(...args) {
        if (this.options.debug) {
            console.log('[WHEPClient]', ...args);
        }
    }

    /**
     * Emit an event
     * @private
     */
    _emit(type, detail = {}) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    /**
     * Start viewing the stream from the WHEP endpoint
     * @returns {Promise<MediaStream>} The received media stream
     */
    async view() {
        if (this.state !== 'idle') {
            throw new Error(`Cannot view in state: ${this.state}`);
        }

        this.state = 'connecting';
        this._emit('connecting');
        this._log('Connecting to WHEP endpoint:', this.endpoint);

        try {
            // Create peer connection
            this.pc = new RTCPeerConnection({
                iceServers: this.options.iceServers,
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require'
            });

            // Initialize stream upfront so callers always get a valid MediaStream
            // even if tracks arrive after view() returns (common with slow WHEP endpoints)
            this._stream = new MediaStream();

            // Set up event handlers
            this._setupPeerConnectionHandlers();

            // Add transceivers for receiving media
            if (this.options.audio) {
                this.pc.addTransceiver('audio', { direction: 'recvonly' });
                this._log('Added audio transceiver');
            }
            if (this.options.video) {
                this.pc.addTransceiver('video', { direction: 'recvonly' });
                this._log('Added video transceiver');
            }

            // Create offer
            const offer = await this.pc.createOffer();
            this._log('Created offer');

            await this.pc.setLocalDescription(offer);

            // Wait for ICE gathering if not using trickle ICE
            let sdp = offer.sdp;
            if (!this.options.trickleIce) {
                await this._waitForIceGathering();
                sdp = this.pc.localDescription.sdp;
            }

            // Send offer to WHEP endpoint
            const response = await this._sendOffer(sdp);

            // Set remote description
            await this.pc.setRemoteDescription({
                type: 'answer',
                sdp: response.sdp
            });

            this._log('Remote description set');

            // Wait for stream to be ready
            await this._waitForStream();

            this.state = 'connected';
            this._emit('connected', { resourceUrl: this.resourceUrl, stream: this._stream });
            this._log('Connected successfully');

            return this._stream;

        } catch (error) {
            this.state = 'error';
            this._emit('error', { error });
            this._log('View failed:', error);
            await this.stop();
            throw error;
        }
    }

    /**
     * Set up peer connection event handlers
     * @private
     */
    _setupPeerConnectionHandlers() {
        // Handle incoming tracks
        this.pc.ontrack = (event) => {
            this._log('Received track:', event.track.kind, event.track.id);

            this._stream.addTrack(event.track);

            this._emit('track', {
                track: event.track,
                streams: event.streams,
                transceiver: event.transceiver
            });
        };

        this.pc.onicecandidate = (event) => {
            // Always buffer candidates when trickle ICE is enabled
            // They will be sent once resourceUrl is available
            if (event.candidate && this.options.trickleIce) {
                this._queueCandidate(event.candidate);
            }
        };

        this.pc.oniceconnectionstatechange = () => {
            if (!this.pc) return;
            this._log('ICE state:', this.pc.iceConnectionState);
            this._emit('icestate', { state: this.pc.iceConnectionState });

            if (this.pc.iceConnectionState === 'failed') {
                this._emit('error', { error: new Error('ICE connection failed') });
            }
            if (this.pc.iceConnectionState === 'disconnected') {
                this._emit('disconnected');
            }
        };

        this.pc.onconnectionstatechange = () => {
            if (!this.pc) return;
            this._log('Connection state:', this.pc.connectionState);
            this._emit('connectionstate', { state: this.pc.connectionState });
        };
    }

    /**
     * Wait for stream to have at least one track
     * Resolves immediately when the first track arrives (don't wait for all requested tracks
     * since many endpoints only provide video or audio, not both)
     * @private
     */
    _waitForStream() {
        return new Promise((resolve) => {
            // Resolve immediately if we already have any track
            if (this._stream && this._stream.getTracks().length > 0) {
                resolve();
                return;
            }

            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                resolve();
            };

            // Short timeout - if no tracks arrive quickly, proceed anyway
            // (the connection may still be establishing or the endpoint may not have media yet)
            const timeout = setTimeout(() => {
                this._log('Stream wait timed out, proceeding');
                done();
            }, 3000);

            // Resolve as soon as we get ANY track
            const onTrack = () => {
                this._log('First track received, stream ready');
                this.removeEventListener('track', onTrack);
                done();
            };

            this.addEventListener('track', onTrack);
        });
    }

    /**
     * Queue ICE candidate for batch sending
     * @private
     */
    _queueCandidate(candidate) {
        this._pendingCandidates.push(candidate);

        // Only start the send timer if we have a resource URL
        // Otherwise candidates will be flushed when resourceUrl becomes available
        if (this.resourceUrl) {
            if (this._candidateTimer) {
                clearTimeout(this._candidateTimer);
            }
            this._candidateTimer = setTimeout(() => {
                this._sendCandidates();
            }, 50);
        }
    }

    /**
     * Flush any buffered ICE candidates
     * Called after resourceUrl becomes available
     * @private
     */
    _flushCandidates() {
        if (this._pendingCandidates.length > 0 && this.resourceUrl) {
            this._log('Flushing', this._pendingCandidates.length, 'buffered ICE candidates');
            // Small delay to batch any candidates that arrive right after
            if (this._candidateTimer) {
                clearTimeout(this._candidateTimer);
            }
            this._candidateTimer = setTimeout(() => {
                this._sendCandidates();
            }, 50);
        }
    }

    /**
     * Send queued ICE candidates via PATCH
     * @private
     */
    async _sendCandidates() {
        if (!this._pendingCandidates.length || !this.resourceUrl) {
            return;
        }

        const candidates = this._pendingCandidates.splice(0);
        this._log('Sending', candidates.length, 'ICE candidates');

        // Format candidates as SDP fragment
        let fragment = 'a=ice-ufrag:' + this._extractIceCredentials().ufrag + '\r\n';
        fragment += 'a=ice-pwd:' + this._extractIceCredentials().pwd + '\r\n';

        for (const candidate of candidates) {
            fragment += 'a=' + candidate.candidate + '\r\n';
        }

        try {
            const headers = {
                'Content-Type': 'application/trickle-ice-sdpfrag',
                ...this._getAuthHeaders()
            };

            if (this.etag) {
                headers['If-Match'] = this.etag;
            }

            const response = await fetch(this.resourceUrl, {
                method: 'PATCH',
                headers,
                body: fragment
            });

            if (!response.ok && response.status !== 204) {
                this._log('PATCH failed:', response.status);
            }
        } catch (error) {
            this._log('Failed to send candidates:', error);
        }
    }

    /**
     * Extract ICE credentials from local description
     * @private
     */
    _extractIceCredentials() {
        const sdp = this.pc.localDescription?.sdp || '';
        const ufragMatch = sdp.match(/a=ice-ufrag:(.+)/);
        const pwdMatch = sdp.match(/a=ice-pwd:(.+)/);
        return {
            ufrag: ufragMatch ? ufragMatch[1].trim() : '',
            pwd: pwdMatch ? pwdMatch[1].trim() : ''
        };
    }

    /**
     * Wait for ICE gathering to complete
     * @private
     */
    _waitForIceGathering() {
        return new Promise((resolve) => {
            if (this.pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }

            const checkState = () => {
                if (this.pc.iceGatheringState === 'complete') {
                    this.pc.removeEventListener('icegatheringstatechange', checkState);
                    resolve();
                }
            };

            this.pc.addEventListener('icegatheringstatechange', checkState);

            // Timeout after 5 seconds
            setTimeout(() => {
                this.pc.removeEventListener('icegatheringstatechange', checkState);
                resolve();
            }, 5000);
        });
    }

    /**
     * Get authentication headers
     * @private
     */
    _getAuthHeaders() {
        const headers = { ...this.options.headers };
        if (this.options.authToken) {
            headers['Authorization'] = `Bearer ${this.options.authToken}`;
        }
        return headers;
    }

    /**
     * Send SDP offer to WHEP endpoint
     * @private
     */
    async _sendOffer(sdp) {
        this._log('Sending offer to', this.endpoint);

        const response = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
                ...this._getAuthHeaders()
            },
            body: sdp
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`WHEP request failed: ${response.status} ${response.statusText} ${errorText}`);
        }

        // Get resource URL from Location header
        const location = response.headers.get('Location');
        if (location) {
            this.resourceUrl = new URL(location, this.endpoint).href;
            this._log('Resource URL:', this.resourceUrl);

            // Flush any ICE candidates that were buffered before resourceUrl was available
            this._flushCandidates();
        }

        // Get ETag for subsequent requests
        this.etag = response.headers.get('ETag');

        // Parse Link header for ICE servers
        const linkHeader = response.headers.get('Link');
        if (linkHeader) {
            this._parseIceServersFromLink(linkHeader);
        }

        const answerSdp = await response.text();
        return { sdp: answerSdp };
    }

    /**
     * Parse ICE servers from Link header
     * @private
     */
    _parseIceServersFromLink(linkHeader) {
        const links = linkHeader.split(',');
        const iceServers = [];

        for (const link of links) {
            const match = link.match(/<([^>]+)>.*rel="ice-server"/);
            if (match) {
                iceServers.push({ urls: match[1] });
            }
        }

        if (iceServers.length > 0) {
            this._log('Received ICE servers from Link header:', iceServers);
        }
    }

    /**
     * Get the received media stream
     * @returns {MediaStream|null}
     */
    getStream() {
        return this._stream;
    }

    /**
     * Get connection statistics
     * @returns {Promise<RTCStatsReport>}
     */
    async getStats() {
        if (!this.pc) {
            throw new Error('Not connected');
        }
        return this.pc.getStats();
    }

    /**
     * Mute/unmute received audio locally
     * @param {boolean} muted - Whether to mute
     */
    muteAudio(muted) {
        if (this._stream) {
            for (const track of this._stream.getAudioTracks()) {
                track.enabled = !muted;
            }
        }
    }

    /**
     * Mute/unmute received video locally
     * @param {boolean} muted - Whether to mute
     */
    muteVideo(muted) {
        if (this._stream) {
            for (const track of this._stream.getVideoTracks()) {
                track.enabled = !muted;
            }
        }
    }

    /**
     * Stop viewing and clean up
     * @returns {Promise<void>}
     */
    async stop() {
        this._log('Stopping');

        // Clear candidate timer
        if (this._candidateTimer) {
            clearTimeout(this._candidateTimer);
            this._candidateTimer = null;
        }

        // Send DELETE to resource URL
        if (this.resourceUrl) {
            try {
                await fetch(this.resourceUrl, {
                    method: 'DELETE',
                    headers: this._getAuthHeaders()
                });
                this._log('Sent DELETE to resource URL');
            } catch (error) {
                this._log('DELETE failed:', error);
            }
        }

        // Stop all tracks
        if (this._stream) {
            for (const track of this._stream.getTracks()) {
                track.stop();
            }
        }

        // Close peer connection
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        this.resourceUrl = null;
        this.etag = null;
        this._pendingCandidates = [];
        this._stream = null;
        this.state = 'idle'; // Reset to idle so client can be reused
        this._emit('stopped');
    }

    /**
     * Restart ICE (if supported by the server)
     * @returns {Promise<void>}
     */
    async restartIce() {
        if (!this.pc || !this.resourceUrl) {
            throw new Error('Not connected');
        }

        this._log('Restarting ICE');

        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(offer);

        if (!this.options.trickleIce) {
            await this._waitForIceGathering();
        }

        const headers = {
            'Content-Type': 'application/sdp',
            ...this._getAuthHeaders()
        };

        if (this.etag) {
            headers['If-Match'] = this.etag;
        }

        const response = await fetch(this.resourceUrl, {
            method: 'PATCH',
            headers,
            body: this.pc.localDescription.sdp
        });

        if (!response.ok) {
            throw new Error(`ICE restart failed: ${response.status}`);
        }

        const answerSdp = await response.text();
        await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

        this.etag = response.headers.get('ETag') || this.etag;
        this._log('ICE restarted');
    }
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WHEPClient;
}
if (typeof window !== 'undefined') {
    window.WHEPClient = WHEPClient;
}

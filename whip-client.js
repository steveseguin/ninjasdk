// SPDX-License-Identifier: MIT
// WHIP Client v1.0.0
// WebRTC-HTTP Ingestion Protocol client for publishing media streams
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
 * WHIPClient - Publish media streams to WHIP-compatible endpoints
 *
 * WHIP (WebRTC-HTTP Ingestion Protocol) is an IETF standard for ingesting
 * media into WebRTC-based platforms using simple HTTP signaling.
 *
 * Compatible endpoints include:
 * - Cloudflare Stream
 * - Twitch (WHIP ingest)
 * - Meshcast.io
 * - Dolby.io
 * - Any WHIP-compliant media server
 *
 * @example
 * const client = new WHIPClient('https://example.com/whip/stream123');
 * await client.publish(mediaStream);
 * // Later...
 * await client.stop();
 */
class WHIPClient extends EventTarget {
    /**
     * Create a new WHIP client
     * @param {string} endpoint - The WHIP endpoint URL
     * @param {Object} [options] - Configuration options
     * @param {string} [options.authToken] - Bearer token for authentication
     * @param {Object} [options.headers] - Additional HTTP headers
     * @param {RTCConfiguration} [options.iceServers] - Custom ICE servers
     * @param {string} [options.videoCodec] - Preferred video codec (e.g., 'h264', 'vp8', 'vp9', 'av1')
     * @param {string} [options.audioCodec] - Preferred audio codec (e.g., 'opus')
     * @param {number} [options.videoBitrate] - Target video bitrate in kbps
     * @param {number} [options.audioBitrate] - Target audio bitrate in kbps
     * @param {boolean} [options.trickleIce=true] - Enable trickle ICE (send candidates via PATCH)
     * @param {boolean} [options.debug=false] - Enable debug logging
     */
    constructor(endpoint, options = {}) {
        super();

        if (!endpoint) {
            throw new Error('WHIP endpoint URL is required');
        }

        this.endpoint = endpoint;
        this.options = {
            authToken: null,
            headers: {},
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun.cloudflare.com:3478' }
            ],
            videoCodec: null,
            audioCodec: null,
            videoBitrate: null,
            audioBitrate: null,
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
            console.log('[WHIPClient]', ...args);
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
     * Publish a media stream to the WHIP endpoint
     * @param {MediaStream} stream - The media stream to publish
     * @returns {Promise<void>}
     */
    async publish(stream) {
        if (this.state !== 'idle') {
            throw new Error(`Cannot publish in state: ${this.state}`);
        }

        if (!stream || !(stream instanceof MediaStream)) {
            throw new Error('Valid MediaStream required');
        }

        this._stream = stream;
        this.state = 'connecting';
        this._emit('connecting');
        this._log('Publishing stream with', stream.getTracks().length, 'tracks');

        try {
            // Create peer connection
            this.pc = new RTCPeerConnection({
                iceServers: this.options.iceServers,
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require'
            });

            // Set up event handlers
            this._setupPeerConnectionHandlers();

            // Add tracks to peer connection
            for (const track of stream.getTracks()) {
                this._log('Adding track:', track.kind, track.id);
                const sender = this.pc.addTrack(track, stream);

                // Apply codec preferences if supported
                if (track.kind === 'video' && this.options.videoCodec) {
                    await this._setCodecPreference(sender, this.options.videoCodec, 'video');
                }
                if (track.kind === 'audio' && this.options.audioCodec) {
                    await this._setCodecPreference(sender, this.options.audioCodec, 'audio');
                }
            }

            // Create offer
            const offer = await this.pc.createOffer();
            this._log('Created offer');

            // Modify SDP if needed (bitrate, etc.)
            let sdp = offer.sdp;
            if (this.options.videoBitrate) {
                sdp = this._setBitrate(sdp, 'video', this.options.videoBitrate);
            }
            if (this.options.audioBitrate) {
                sdp = this._setBitrate(sdp, 'audio', this.options.audioBitrate);
            }

            await this.pc.setLocalDescription({ type: 'offer', sdp });

            // Wait for ICE gathering if not using trickle ICE
            if (!this.options.trickleIce) {
                await this._waitForIceGathering();
                sdp = this.pc.localDescription.sdp;
            }

            // Send offer to WHIP endpoint
            const response = await this._sendOffer(sdp);

            // Set remote description
            await this.pc.setRemoteDescription({
                type: 'answer',
                sdp: response.sdp
            });

            this._log('Remote description set');

            // Apply bitrate limits via sender parameters
            await this._applyBitrateLimits();

            this.state = 'connected';
            this._emit('connected', { resourceUrl: this.resourceUrl });
            this._log('Connected successfully');

        } catch (error) {
            this.state = 'error';
            this._emit('error', { error });
            this._log('Publish failed:', error);
            await this.stop();
            throw error;
        }
    }

    /**
     * Set up peer connection event handlers
     * @private
     */
    _setupPeerConnectionHandlers() {
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
     * Send SDP offer to WHIP endpoint
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
            throw new Error(`WHIP request failed: ${response.status} ${response.statusText} ${errorText}`);
        }

        // Get resource URL from Location header
        const location = response.headers.get('Location');
        if (location) {
            // Handle relative URLs
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
        // Parse Link header format: <stun:stun.example.com>; rel="ice-server"
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
     * Set codec preference on sender
     * @private
     */
    async _setCodecPreference(sender, codecName, kind) {
        // getCapabilities is a static method on RTCRtpSender, not an instance method
        // Also check RTCRtpSender exists (not available in Node.js)
        if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) {
            return;
        }

        try {
            const capabilities = RTCRtpSender.getCapabilities(kind);
            if (!capabilities) return;

            const codecs = capabilities.codecs.filter(codec => {
                return codec.mimeType.toLowerCase().includes(codecName.toLowerCase());
            });

            if (codecs.length > 0 && sender.setCodecPreferences) {
                // Put preferred codecs first, then add others
                const otherCodecs = capabilities.codecs.filter(codec => {
                    return !codec.mimeType.toLowerCase().includes(codecName.toLowerCase());
                });
                sender.setCodecPreferences([...codecs, ...otherCodecs]);
                this._log('Set', kind, 'codec preference to', codecName);
            }
        } catch (error) {
            this._log('Could not set codec preference:', error);
        }
    }

    /**
     * Modify SDP to set bitrate
     * @private
     */
    _setBitrate(sdp, kind, kbps) {
        const lines = sdp.split('\r\n');
        const result = [];
        let inMedia = false;
        let mediaType = '';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            result.push(line);

            if (line.startsWith('m=')) {
                mediaType = line.split(' ')[0].substring(2);
                inMedia = mediaType === kind;
            }

            // Add b=AS line after c= line for the target media
            if (inMedia && line.startsWith('c=')) {
                result.push(`b=AS:${kbps}`);
            }
        }

        return result.join('\r\n');
    }

    /**
     * Apply bitrate limits via sender parameters
     * @private
     */
    async _applyBitrateLimits() {
        if (!this.pc) return;

        for (const sender of this.pc.getSenders()) {
            if (!sender.track) continue;

            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }

            let bitrate = null;
            if (sender.track.kind === 'video' && this.options.videoBitrate) {
                bitrate = this.options.videoBitrate * 1000; // kbps to bps
            }
            if (sender.track.kind === 'audio' && this.options.audioBitrate) {
                bitrate = this.options.audioBitrate * 1000;
            }

            if (bitrate) {
                for (const encoding of params.encodings) {
                    encoding.maxBitrate = bitrate;
                }
                try {
                    await sender.setParameters(params);
                    this._log('Set', sender.track.kind, 'bitrate to', bitrate / 1000, 'kbps');
                } catch (error) {
                    this._log('Could not set bitrate:', error);
                }
            }
        }
    }

    /**
     * Replace a track in the active session
     * @param {MediaStreamTrack} oldTrack - The track to replace
     * @param {MediaStreamTrack} newTrack - The new track
     * @returns {Promise<void>}
     */
    async replaceTrack(oldTrack, newTrack) {
        if (!this.pc) {
            throw new Error('Not connected');
        }

        for (const sender of this.pc.getSenders()) {
            if (sender.track === oldTrack) {
                await sender.replaceTrack(newTrack);
                this._log('Replaced track:', oldTrack.kind);
                return;
            }
        }

        throw new Error('Track not found');
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
     * Stop publishing and clean up
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
    module.exports = WHIPClient;
}
if (typeof window !== 'undefined') {
    window.WHIPClient = WHIPClient;
}

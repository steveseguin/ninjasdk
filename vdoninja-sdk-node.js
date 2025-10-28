/**
 * VDO.Ninja SDK - Node.js Version with WebRTC Adapter
 * 
 * This version extends the main SDK to support multiple WebRTC implementations
 * in Node.js environments. It automatically detects and uses:
 * - @roamhq/wrtc (recommended, full media support)
 * - node-datachannel (data channels only, no media)
 * 
 * Usage:
 * const VDONinjaSDK = require('./vdoninja-sdk-node.js');
 * const sdk = new VDONinjaSDK({ room: 'myroom' });
 * 
 * // Check which implementation is being used
 * console.log('Using WebRTC:', sdk.webrtcAdapter.getImplementation());
 * console.log('Media support:', sdk.webrtcAdapter.hasMediaSupport());
 */

// Check for required dependencies
try {
    require.resolve('ws');
} catch (e) {
    console.error('ERROR: WebSocket module not found. Please install it with: npm install ws');
    process.exit(1);
}

// Load the WebRTC adapter
const WebRTCAdapter = require('./webrtc-adapter.js');

// Load the original SDK
const originalSDKCode = require('fs').readFileSync(__dirname + '/vdoninja-sdk.js', 'utf8');

// Import TextEncoder/TextDecoder
const { TextEncoder, TextDecoder } = require('util');

// AbortController - use native if available (Node 15+), otherwise polyfill
let AbortControllerPolyfill;
try {
    AbortControllerPolyfill = AbortController;
} catch (e) {
    AbortControllerPolyfill = require('abort-controller').AbortController;
}

// Create EventTarget polyfill for older Node versions
let EventTargetPolyfill;
try {
    // Try to use native EventTarget (Node 15+)
    EventTargetPolyfill = EventTarget;
} catch (e) {
    // Fallback to events.EventEmitter wrapped as EventTarget
    const { EventEmitter } = require('events');
    EventTargetPolyfill = class EventTarget extends EventEmitter {
        constructor() {
            super();
            this._emitter = this;
        }
        addEventListener(type, listener) {
            this.on(type, listener);
        }
        removeEventListener(type, listener) {
            this.off(type, listener);
        }
        dispatchEvent(event) {
            this.emit(event.type, event);
            return true;
        }
    };
}

// Create CustomEvent using native Event if available
let CustomEventPolyfill;
try {
    // Try to use native CustomEvent (Node 19+)
    CustomEventPolyfill = CustomEvent;
} catch (e) {
    // Fallback for older Node versions
    CustomEventPolyfill = class extends Event {
        constructor(type, options = {}) {
            super(type, options);
            this.detail = options.detail || null;
        }
    };
}

// Initialize WebRTC adapter BEFORE creating context
const webrtcAdapter = new WebRTCAdapter();

// Create a module context and evaluate the SDK
const sdkModule = { exports: {} };
const sdkContext = {
    module: sdkModule,
    exports: sdkModule.exports,
    require: require,
    __dirname: __dirname,
    __filename: __filename,
    global: global,
    console: console,
    process: process,
    Buffer: Buffer,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    setImmediate: setImmediate,
    clearImmediate: clearImmediate,
    EventTarget: EventTargetPolyfill,
    WebSocket: require('ws'),
    crypto: require('crypto'),
    document: {
        createElement: () => ({ innerText: '', textContent: '' })
    },
    window: {
        crypto: require('crypto').webcrypto || require('crypto'),
        EventTarget: EventTargetPolyfill
    },
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    CustomEvent: CustomEventPolyfill,
    AbortController: AbortControllerPolyfill,
    RTCPeerConnection: webrtcAdapter.RTCPeerConnection,
    RTCSessionDescription: webrtcAdapter.RTCSessionDescription,
    RTCIceCandidate: webrtcAdapter.RTCIceCandidate,
    MediaStream: webrtcAdapter.MediaStream,
    MediaStreamTrack: webrtcAdapter.MediaStreamTrack,
    RTCAudioSource: webrtcAdapter.nonstandard?.RTCAudioSource,
    RTCAudioSink: webrtcAdapter.nonstandard?.RTCAudioSink,
    fetch: fetch
};

// Evaluate SDK in isolated context
const vm = require('vm');
vm.runInNewContext(originalSDKCode, sdkContext);

// Get the original SDK class - it should be in module.exports
const OriginalVDONinjaSDK = sdkModule.exports;

// Create extended SDK class with WebRTC adapter
class VDONinjaSDKNode extends OriginalVDONinjaSDK {
    constructor(options = {}) {
        // Call parent constructor
        super(options);
        
        // Store adapter reference (use the global one we created)
        this.webrtcAdapter = webrtcAdapter;
        
        // Log implementation details
        if (this.debug) {
            console.log(`[VDO.Ninja SDK] Using WebRTC implementation: ${webrtcAdapter.getImplementation()}`);
            console.log(`[VDO.Ninja SDK] Media support available: ${webrtcAdapter.hasMediaSupport()}`);
        }
        
        // Add event emitter style methods for Node.js compatibility
        this.on = this.addEventListener;
        this.off = this.removeEventListener;
        this.emit = (event, data) => {
            if (typeof event === 'string') {
                this._emit(event, data);
            } else {
                this.dispatchEvent(event);
            }
        };
    }
    
    /**
     * Override _emit to handle Node.js environment
     * @private
     */
    _emit(eventName, detail = {}) {
        // For Node.js, we need to handle events differently
        const event = new CustomEventPolyfill(eventName, { detail });
        
        // Get all listeners for this event
        const listeners = this.listeners ? this.listeners(eventName) : [];
        
        // If using EventEmitter-style (Node.js)
        if (this._events && this._events[eventName]) {
            // Emit using EventEmitter style
            super.emit(eventName, event);
        } else {
            // Try native dispatchEvent if available
            try {
                super._emit(eventName, detail);
            } catch (e) {
                // Fallback to manual listener invocation
                if (this._eventListeners && this._eventListeners[eventName]) {
                    this._eventListeners[eventName].forEach(listener => {
                        listener.call(this, event);
                    });
                }
            }
        }
    }
    
    /**
     * Override _createConnection to use adapter - REMOVED
     * The parent class will handle this properly
     * @private
     */
    
    /**
     * Override publish to check media support
     */
    async publish(streamOrOptions, maybeOptions = {}) {
        const MediaStreamCtor = this.webrtcAdapter.MediaStream || global.MediaStream;
        let stream = streamOrOptions;
        let options = maybeOptions;

        // Support legacy style: publish({ stream, ...options })
        if (
            streamOrOptions &&
            typeof streamOrOptions === 'object' &&
            !(MediaStreamCtor && streamOrOptions instanceof MediaStreamCtor) &&
            !(typeof streamOrOptions.getTracks === 'function') &&
            streamOrOptions.stream
        ) {
            stream = streamOrOptions.stream;
            options = { ...streamOrOptions };
            delete options.stream;
        }

        const isMediaStream = MediaStreamCtor && stream instanceof MediaStreamCtor;
        const isMediaLike = isMediaStream || (stream && typeof stream.getTracks === 'function');
        const wantsMedia = isMediaLike || options.audio || options.video;

        if (wantsMedia && !this.webrtcAdapter.hasMediaSupport()) {
            throw new Error(
                `Media publishing not supported with ${this.webrtcAdapter.getImplementation()}. ` +
                `Please install @roamhq/wrtc for audio/video support.`
            );
        }

        return super.publish(stream, options);
    }
    
    /**
     * Get WebRTC implementation details
     */
    getWebRTCInfo() {
        return {
            implementation: this.webrtcAdapter.getImplementation(),
            hasMediaSupport: this.webrtcAdapter.hasMediaSupport(),
            adapter: this.webrtcAdapter
        };
    }
    
    /**
     * Static method to check available WebRTC implementations
     */
    static checkWebRTCSupport() {
        const implementations = [];
        
        // Check @roamhq/wrtc
        try {
            require.resolve('@roamhq/wrtc');
            implementations.push({
                name: '@roamhq/wrtc',
                available: true,
                mediaSupport: true,
                recommended: true
            });
        } catch (e) {
            implementations.push({
                name: '@roamhq/wrtc',
                available: false,
                mediaSupport: true,
                recommended: true
            });
        }
        
        // Check node-datachannel
        try {
            require.resolve('node-datachannel');
            implementations.push({
                name: 'node-datachannel',
                available: true,
                mediaSupport: false,
                recommended: false
            });
        } catch (e) {
            implementations.push({
                name: 'node-datachannel', 
                available: false,
                mediaSupport: false,
                recommended: false
            });
        }
        
        return implementations;
    }
}

// Export the Node.js SDK
module.exports = VDONinjaSDKNode;

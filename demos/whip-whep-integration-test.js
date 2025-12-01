#!/usr/bin/env node
/**
 * WHIP/WHEP Integration Test
 *
 * This test:
 * 1. Publishes a synthetic video/audio stream to Meshcast via WHIP
 * 2. Waits for the stream to be available
 * 3. Pulls the stream via WHEP
 * 4. Verifies that tracks are received
 *
 * Usage: node demos/whip-whep-integration-test.js
 *
 * Requires: npm install @roamhq/wrtc
 */

const WHIPClient = require('../whip-client.js');
const WHEPClient = require('../whep-client.js');

// Check for WebRTC support
let wrtc;
try {
    wrtc = require('@roamhq/wrtc');
    console.log('✅ Using @roamhq/wrtc for WebRTC');
} catch (e) {
    console.error('❌ @roamhq/wrtc not found. Install with: npm install @roamhq/wrtc');
    process.exit(1);
}

// Polyfills for Node.js
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.MediaStream = wrtc.MediaStream;
global.MediaStreamTrack = wrtc.MediaStreamTrack;

// Generate unique stream ID
const streamId = 'sdk-test-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now();
const WHIP_URL = `https://cae1.meshcast.io/whip/${streamId}`;
const WHEP_URL = `https://cae1.meshcast.io/whep/${streamId}`;

console.log('');
console.log('🧪 WHIP/WHEP Integration Test');
console.log('═'.repeat(50));
console.log(`Stream ID: ${streamId}`);
console.log(`WHIP URL:  ${WHIP_URL}`);
console.log(`WHEP URL:  ${WHEP_URL}`);
console.log('═'.repeat(50));
console.log('');

// Helper to create synthetic audio track using RTCAudioSource
function createSyntheticAudioTrack() {
    const nonstandard = wrtc.nonstandard || {};
    if (!nonstandard.RTCAudioSource) {
        console.log('⚠️  RTCAudioSource not available, skipping audio');
        return null;
    }

    const source = new nonstandard.RTCAudioSource();
    const track = source.createTrack();

    // Generate sine wave audio
    const sampleRate = 48000;
    const frequency = 440; // A4 note
    const amplitude = 0.25;
    const framesPerBuffer = 480; // 10ms at 48kHz
    let phase = 0;
    const omega = 2 * Math.PI * frequency / sampleRate;

    const interval = setInterval(() => {
        const samples = new Int16Array(framesPerBuffer);
        for (let i = 0; i < framesPerBuffer; i++) {
            samples[i] = Math.round(Math.sin(phase) * amplitude * 32767);
            phase += omega;
            if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        }
        source.onData({
            samples,
            sampleRate,
            bitsPerSample: 16,
            channelCount: 1,
            numberOfFrames: framesPerBuffer
        });
    }, 10);

    return {
        track,
        stop: () => {
            clearInterval(interval);
            try { track.stop(); } catch (e) {}
        }
    };
}

// Helper to create synthetic video track using RTCVideoSource
function createSyntheticVideoTrack() {
    const nonstandard = wrtc.nonstandard || {};
    if (!nonstandard.RTCVideoSource) {
        console.log('⚠️  RTCVideoSource not available, skipping video');
        return null;
    }

    const source = new nonstandard.RTCVideoSource();
    const track = source.createTrack();

    const width = 640;
    const height = 480;
    const frameData = new Uint8ClampedArray(width * height * 4);
    let frameCount = 0;

    const interval = setInterval(() => {
        // Generate a simple animated pattern (color bars that shift)
        const offset = frameCount % 256;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                frameData[i] = (x + offset) % 256;     // R
                frameData[i + 1] = (y + offset) % 256; // G
                frameData[i + 2] = 128;                // B
                frameData[i + 3] = 255;                // A
            }
        }

        const frame = {
            width,
            height,
            data: new Uint8ClampedArray(width * height * 1.5) // I420 format
        };

        // Convert RGBA to I420
        const yPlane = frame.data.subarray(0, width * height);
        const uPlane = frame.data.subarray(width * height, width * height * 1.25);
        const vPlane = frame.data.subarray(width * height * 1.25);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                const r = frameData[i];
                const g = frameData[i + 1];
                const b = frameData[i + 2];

                // Y plane
                yPlane[y * width + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);

                // U and V planes (subsampled)
                if (y % 2 === 0 && x % 2 === 0) {
                    const uIndex = (y / 2) * (width / 2) + (x / 2);
                    uPlane[uIndex] = Math.round(-0.169 * r - 0.331 * g + 0.5 * b + 128);
                    vPlane[uIndex] = Math.round(0.5 * r - 0.419 * g - 0.081 * b + 128);
                }
            }
        }

        source.onFrame(frame);
        frameCount++;
    }, 33); // ~30fps

    return {
        track,
        stop: () => {
            clearInterval(interval);
            try { track.stop(); } catch (e) {}
        }
    };
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
    let whipClient = null;
    let whepClient = null;
    let audioSource = null;
    let videoSource = null;

    try {
        // Step 1: Create synthetic media
        console.log('📹 Creating synthetic media stream...');

        audioSource = createSyntheticAudioTrack();
        videoSource = createSyntheticVideoTrack();

        const tracks = [];
        if (audioSource) tracks.push(audioSource.track);
        if (videoSource) tracks.push(videoSource.track);

        if (tracks.length === 0) {
            throw new Error('No media tracks available. Ensure @roamhq/wrtc is properly installed.');
        }

        const stream = new wrtc.MediaStream(tracks);
        console.log(`   ✓ Created stream with ${tracks.length} track(s)`);

        // Step 2: Publish via WHIP
        console.log('');
        console.log('📤 Publishing via WHIP...');

        whipClient = new WHIPClient(WHIP_URL, {
            debug: false,
            trickleIce: false, // Wait for all candidates
            videoCodec: 'vp8'  // Use VP8 for better compatibility
        });

        whipClient.addEventListener('connected', () => {
            console.log('   ✓ WHIP connected');
        });

        whipClient.addEventListener('icestate', (e) => {
            console.log(`   ICE state: ${e.detail.state}`);
        });

        await whipClient.publish(stream);
        console.log('   ✓ Publishing started');

        // Step 3: Wait for stream to propagate
        console.log('');
        console.log('⏳ Waiting 10 seconds for stream to propagate...');
        await sleep(10000);

        // Step 4: Pull via WHEP
        console.log('');
        console.log('📥 Pulling via WHEP...');

        whepClient = new WHEPClient(WHEP_URL, {
            debug: false,
            trickleIce: false,
            audio: !!audioSource,
            video: !!videoSource
        });

        let receivedTracks = [];
        let trackPromiseResolve;
        const trackPromise = new Promise(resolve => { trackPromiseResolve = resolve; });

        whepClient.addEventListener('track', (e) => {
            console.log(`   ✓ Received ${e.detail.track.kind} track`);
            receivedTracks.push(e.detail.track);

            // Check if we have all expected tracks
            const expectedTracks = (audioSource ? 1 : 0) + (videoSource ? 1 : 0);
            if (receivedTracks.length >= expectedTracks) {
                trackPromiseResolve();
            }
        });

        whepClient.addEventListener('connected', () => {
            console.log('   ✓ WHEP connected');
        });

        whepClient.addEventListener('icestate', (e) => {
            console.log(`   ICE state: ${e.detail.state}`);
        });

        await whepClient.view();
        console.log('   ✓ Viewing started');

        // Wait for tracks with timeout
        console.log('');
        console.log('⏳ Waiting for tracks (max 30 seconds)...');

        const timeout = setTimeout(() => {
            trackPromiseResolve(); // Resolve anyway after timeout
        }, 30000);

        await trackPromise;
        clearTimeout(timeout);

        // Step 5: Verify results
        console.log('');
        console.log('═'.repeat(50));
        console.log('📊 Results:');
        console.log('─'.repeat(50));

        const expectedTracks = (audioSource ? 1 : 0) + (videoSource ? 1 : 0);
        const audioReceived = receivedTracks.some(t => t.kind === 'audio');
        const videoReceived = receivedTracks.some(t => t.kind === 'video');

        console.log(`   Expected tracks: ${expectedTracks}`);
        console.log(`   Received tracks: ${receivedTracks.length}`);
        console.log(`   Audio: ${audioSource ? (audioReceived ? '✓' : '✗') : 'N/A'}`);
        console.log(`   Video: ${videoSource ? (videoReceived ? '✓' : '✗') : 'N/A'}`);

        if (receivedTracks.length >= expectedTracks) {
            console.log('');
            console.log('✅ TEST PASSED! WHIP/WHEP integration working.');
            console.log('═'.repeat(50));
            return true;
        } else {
            console.log('');
            console.log('❌ TEST FAILED! Did not receive expected tracks.');
            console.log('═'.repeat(50));
            return false;
        }

    } catch (error) {
        console.error('');
        console.error('❌ Error:', error.message);
        console.error(error.stack);
        return false;

    } finally {
        // Cleanup
        console.log('');
        console.log('🧹 Cleaning up...');

        if (whepClient) {
            await whepClient.stop().catch(() => {});
        }
        if (whipClient) {
            await whipClient.stop().catch(() => {});
        }
        if (audioSource) {
            audioSource.stop();
        }
        if (videoSource) {
            videoSource.stop();
        }

        console.log('   ✓ Cleanup complete');
    }
}

// Run the test
runTest().then(success => {
    process.exit(success ? 0 : 1);
}).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

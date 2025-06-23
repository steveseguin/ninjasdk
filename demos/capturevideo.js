/**
 * VDO.Ninja Discord Auto-Publisher
 * 
 * This Chrome extension automatically publishes Discord video streams to VDO.Ninja
 * Updated to use the external VDO.Ninja SDK
 * 
 * @author Steve Seguin
 * @license AGPLv3
 */

(function() {
    'use strict';
    
    // Check if SDK is available
    if (typeof VDONinjaSDK === 'undefined') {
        console.error('VDONinjaSDK not found! Make sure vdoninja-sdk.js is loaded before this script.');
        return;
    }
    
    // Early initialization: Hook RTCPeerConnection to capture audio streams
    (function setupRTCHook() {
        if (window._rtcHookInstalled) return;
        window._rtcHookInstalled = true;
        window._rtcAudioStreams = new Set();
        window._rtcPeerConnections = new Set();
        
        const OriginalRTCPeerConnection = window.RTCPeerConnection;
        
        window.RTCPeerConnection = function(...args) {
            const pc = new OriginalRTCPeerConnection(...args);
            window._rtcPeerConnections.add(pc);
            
            // Listen for remote streams
            pc.addEventListener('track', (event) => {
                if (event.track.kind === 'audio' && event.streams[0]) {
                    console.log('[RTC Hook] Captured remote audio track:', event.track.label);
                    window._rtcAudioStreams.add(event.streams[0]);
                }
            });
            
            // Also capture local streams when added
            const originalAddStream = pc.addStream;
            if (originalAddStream) {
                pc.addStream = function(stream) {
                    if (stream.getAudioTracks().length > 0) {
                        console.log('[RTC Hook] Captured local audio stream');
                        window._rtcAudioStreams.add(stream);
                    }
                    return originalAddStream.apply(this, arguments);
                };
            }
            
            const originalAddTrack = pc.addTrack;
            if (originalAddTrack) {
                pc.addTrack = function(track, ...streams) {
                    if (track.kind === 'audio' && streams[0]) {
                        console.log('[RTC Hook] Captured local audio track:', track.label);
                        window._rtcAudioStreams.add(streams[0]);
                    }
                    return originalAddTrack.apply(this, arguments);
                };
            }
            
            return pc;
        };
        
        // Copy static methods and properties
        Object.setPrototypeOf(window.RTCPeerConnection, OriginalRTCPeerConnection);
        Object.setPrototypeOf(window.RTCPeerConnection.prototype, OriginalRTCPeerConnection.prototype);
        
        console.log('[RTC Hook] RTCPeerConnection hook installed');
    })();
    
    // Configuration
    const ROOM_ID = 'autopublish_' + Math.random().toString(36).substring(7);
    const VDO_NINJA_URL = 'https://vdo.ninja';
    
    // Map to track published videos and their VDO instances
    const publishedVideos = new Map();
    
    // Group scene overlay element
    let groupSceneOverlay = null;
    
    // Track when page loaded to delay overlays
    const pageLoadTime = Date.now();
    const OVERLAY_DELAY = 3000; // 3 seconds
    
    // Track if VDO.Ninja is enabled
    let vdoNinjaEnabled = false;
    
    // Settings from background script
    let settings = {};
    
    // Check initial state
    chrome.storage.local.get(['vdoninjadiscord'], function(result) {
        vdoNinjaEnabled = result.vdoninjadiscord === true;
        if (vdoNinjaEnabled) {
            console.log('VDO.Ninja Direct WebRTC Auto-Publisher initialized');
            console.log('Room ID:', ROOM_ID);
            console.log(`View URL: ${VDO_NINJA_URL}/?room=${ROOM_ID}&scene`);
            // Process any videos that loaded before we got the setting
            processExistingVideos();
        } else {
            console.log('VDO.Ninja Discord integration is disabled');
        }
    });
    
    // Listen for changes to the setting
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.vdoninjadiscord) {
            const wasEnabled = vdoNinjaEnabled;
            vdoNinjaEnabled = changes.vdoninjadiscord.newValue === true;
            
            if (vdoNinjaEnabled && !wasEnabled) {
                console.log('VDO.Ninja Discord integration enabled');
                processExistingVideos();
            } else if (!vdoNinjaEnabled && wasEnabled) {
                console.log('VDO.Ninja Discord integration disabled');
                unpublishAllVideos();
            }
        }
    });
    
    // Create overlay button
    function createOverlayButton(streamID) {
        const button = document.createElement('div');
        button.className = 'vdo-ninja-overlay-btn';
        button.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            <span>Stream ${streamID}</span>
        `;
        
        // Copy to clipboard on click
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const url = `${VDO_NINJA_URL}/?view=${streamID}&room=${ROOM_ID}`;
            navigator.clipboard.writeText(url).then(() => {
                button.style.backgroundColor = '#4CAF50';
                button.querySelector('span').textContent = 'Copied!';
                setTimeout(() => {
                    button.style.backgroundColor = '';
                    button.querySelector('span').textContent = `Stream ${streamID}`;
                }, 2000);
            });
        });
        
        return button;
    }
    
    // Create group scene overlay
    function createGroupSceneOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'vdo-ninja-scene-overlay';
        overlay.innerHTML = `
            <button class="vdo-ninja-scene-btn">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM5 19V5h14v14H5z"/>
                    <path d="M7 7h4v4H7zm6 0h4v4h-4zm-6 6h4v4H7zm6 0h4v4h-4z"/>
                </svg>
                <span>Group Scene</span>
            </button>
        `;
        
        const button = overlay.querySelector('button');
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const url = `${VDO_NINJA_URL}/?room=${ROOM_ID}&scene`;
            navigator.clipboard.writeText(url).then(() => {
                button.style.backgroundColor = '#4CAF50';
                button.querySelector('span').textContent = 'Copied!';
                setTimeout(() => {
                    button.style.backgroundColor = '';
                    button.querySelector('span').textContent = 'Group Scene';
                }, 2000);
            });
        });
        
        return overlay;
    }
    
    // Style injection
    function injectStyles() {
        if (document.getElementById('vdo-ninja-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'vdo-ninja-styles';
        style.textContent = `
            .vdo-ninja-overlay-btn {
                position: absolute;
                top: 10px;
                right: 10px;
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 8px 12px;
                border-radius: 6px;
                cursor: pointer;
                z-index: 1000;
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 12px;
                font-family: Arial, sans-serif;
                transition: all 0.3s ease;
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.1);
            }
            
            .vdo-ninja-overlay-btn:hover {
                background: rgba(0, 0, 0, 0.9);
                transform: scale(1.05);
            }
            
            .vdo-ninja-scene-overlay {
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10000;
                animation: fadeIn 0.3s ease;
            }
            
            .vdo-ninja-scene-btn {
                background: rgba(0, 0, 0, 0.9);
                color: white;
                padding: 12px 20px;
                border-radius: 8px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 14px;
                font-family: Arial, sans-serif;
                border: 2px solid #2196F3;
                transition: all 0.3s ease;
                backdrop-filter: blur(10px);
            }
            
            .vdo-ninja-scene-btn:hover {
                background: #2196F3;
                transform: scale(1.05);
            }
            
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(-10px); }
                to { opacity: 1; transform: translateY(0); }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Generate a unique streamID
    function generateStreamID() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 6; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    
    // Publish a video element using the current SDK
    async function publishVideo(video) {
        if (!vdoNinjaEnabled) return;
        
        // Skip if already published
        if (publishedVideos.has(video)) {
            console.log('Video already published');
            return;
        }
        
        try {
            // Create stream from video element
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            // Match video dimensions
            canvas.width = video.videoWidth || 1280;
            canvas.height = video.videoHeight || 720;
            
            // Draw video to canvas
            function drawFrame() {
                if (!publishedVideos.has(video)) return;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                requestAnimationFrame(drawFrame);
            }
            drawFrame();
            
            // Get video stream from canvas
            const videoStream = canvas.captureStream(30);
            
            // Try to get audio from WebRTC or create silent track
            let audioStream = null;
            if (window._rtcAudioStreams && window._rtcAudioStreams.size > 0) {
                const rtcStream = Array.from(window._rtcAudioStreams)[0];
                if (rtcStream.getAudioTracks().length > 0) {
                    audioStream = new MediaStream(rtcStream.getAudioTracks());
                    console.log('Using WebRTC audio track');
                }
            }
            
            if (!audioStream) {
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                gainNode.gain.value = 0; // Silent
                oscillator.connect(gainNode);
                const destination = audioContext.createMediaStreamDestination();
                gainNode.connect(destination);
                oscillator.start();
                audioStream = destination.stream;
                console.log('Using silent audio track');
            }
            
            // Combine streams
            const combinedStream = new MediaStream([
                ...videoStream.getVideoTracks(),
                ...audioStream.getAudioTracks()
            ]);
            
            // Generate streamID
            const streamID = generateStreamID();
            
            // Create SDK instance
            const vdo = new VDONinjaSDK({
                room: ROOM_ID,
                password: false, // No encryption for this demo
                debug: true
            });
            
            // Set up event listeners
            vdo.addEventListener('connected', () => {
                console.log(`[Stream ${streamID}] Connected to server`);
            });
            
            vdo.addEventListener('disconnected', () => {
                console.log(`[Stream ${streamID}] Disconnected from server`);
            });
            
            vdo.addEventListener('error', (event) => {
                console.error(`[Stream ${streamID}] Error:`, event.detail);
            });
            
            // Connect and publish
            await vdo.connect();
            await vdo.publish(combinedStream, { streamID });
            
            console.log(`Video published with streamID: ${streamID}`);
            console.log(`View URL: ${VDO_NINJA_URL}/?view=${streamID}&room=${ROOM_ID}`);
            
            // Store reference
            publishedVideos.set(video, {
                vdo,
                streamID,
                stream: combinedStream,
                canvas
            });
            
            // Add overlay button
            if (Date.now() - pageLoadTime > OVERLAY_DELAY) {
                const container = video.closest('div') || video.parentElement;
                if (container) {
                    container.style.position = 'relative';
                    const overlay = createOverlayButton(streamID);
                    container.appendChild(overlay);
                }
            }
            
        } catch (error) {
            console.error('Failed to publish video:', error);
        }
    }
    
    // Unpublish a video
    function unpublishVideo(video) {
        const publication = publishedVideos.get(video);
        if (!publication) return;
        
        try {
            // Disconnect SDK
            publication.vdo.disconnect();
            
            // Stop streams
            publication.stream.getTracks().forEach(track => track.stop());
            
            // Remove overlay
            const container = video.closest('div') || video.parentElement;
            if (container) {
                const overlay = container.querySelector('.vdo-ninja-overlay-btn');
                if (overlay) overlay.remove();
            }
            
            console.log(`Video unpublished: ${publication.streamID}`);
        } catch (error) {
            console.error('Error unpublishing video:', error);
        } finally {
            publishedVideos.delete(video);
        }
    }
    
    // Unpublish all videos
    function unpublishAllVideos() {
        publishedVideos.forEach((_, video) => unpublishVideo(video));
        
        // Remove group scene overlay
        if (groupSceneOverlay) {
            groupSceneOverlay.remove();
            groupSceneOverlay = null;
        }
    }
    
    // Process existing videos
    function processExistingVideos() {
        if (!vdoNinjaEnabled) return;
        
        const videos = document.querySelectorAll('video[src], video source');
        videos.forEach(element => {
            const video = element.tagName === 'SOURCE' ? element.closest('video') : element;
            if (video && video.readyState >= 3) {
                publishVideo(video);
            }
        });
    }
    
    // Intersection Observer for video visibility
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const video = entry.target;
            
            if (entry.isIntersecting && video.readyState >= 3) {
                publishVideo(video);
            } else if (!entry.isIntersecting && publishedVideos.has(video)) {
                // Optionally unpublish when video goes off-screen
                // unpublishVideo(video);
            }
        });
    }, {
        threshold: 0.5
    });
    
    // Mutation Observer for new videos
    const mutationObserver = new MutationObserver((mutations) => {
        if (!vdoNinjaEnabled) return;
        
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeName === 'VIDEO') {
                    handleNewVideo(node);
                } else if (node.querySelectorAll) {
                    const videos = node.querySelectorAll('video');
                    videos.forEach(handleNewVideo);
                }
            });
            
            mutation.removedNodes.forEach(node => {
                if (node.nodeName === 'VIDEO' && publishedVideos.has(node)) {
                    unpublishVideo(node);
                } else if (node.querySelectorAll) {
                    const videos = node.querySelectorAll('video');
                    videos.forEach(video => {
                        if (publishedVideos.has(video)) {
                            unpublishVideo(video);
                        }
                    });
                }
            });
        });
        
        // Show group scene overlay if we have published videos
        if (publishedVideos.size > 0 && !groupSceneOverlay && Date.now() - pageLoadTime > OVERLAY_DELAY) {
            groupSceneOverlay = createGroupSceneOverlay();
            document.body.appendChild(groupSceneOverlay);
        }
    });
    
    // Handle new video elements
    function handleNewVideo(video) {
        // Wait for video to be ready
        if (video.readyState >= 3) {
            observer.observe(video);
            if (video.getBoundingClientRect().width > 0) {
                publishVideo(video);
            }
        } else {
            video.addEventListener('loadeddata', () => {
                observer.observe(video);
                if (video.getBoundingClientRect().width > 0) {
                    publishVideo(video);
                }
            }, { once: true });
        }
    }
    
    // Initialize
    function initialize() {
        injectStyles();
        
        // Start observing
        mutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        // Process any existing videos
        if (vdoNinjaEnabled) {
            processExistingVideos();
        }
    }
    
    // Wait for DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        unpublishAllVideos();
    });
    
    // Debug info
    window.VDONinjaDebug = {
        roomID: ROOM_ID,
        publishedVideos,
        republish: processExistingVideos,
        unpublishAll: unpublishAllVideos
    };
    
})();
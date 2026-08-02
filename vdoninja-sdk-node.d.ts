// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
// See LICENSE-MIT for the full terms.

/// <reference lib="dom" />

import VDONinja from './vdoninja-sdk';

export type {
    Password,
    VDONinjaOptions,
    MediaPreferences,
    PublishOptions,
    ViewOptions,
    DataTarget,
    FileSource,
    HostFileOptions,
    HostedFile,
    AdvertisedFile,
    RequestFileOptions,
    FileTransferResult,
    ChannelOptions,
    ResourceMetadata,
    PeerQuality,
    SDKState,
    DisconnectedDetail,
    FileTransferProgressDetail,
    VDONinjaEventMap,
    VDONinjaEvent
} from './vdoninja-sdk';

export interface WebRTCAdapter {
    getImplementation(): string;
    hasMediaSupport(): boolean;
    [key: string]: unknown;
}

export interface WebRTCSupport {
    name: '@roamhq/wrtc' | 'node-datachannel' | string;
    available: boolean;
    mediaSupport: boolean;
    recommended: boolean;
}

export interface WebRTCInfo {
    implementation: string;
    hasMediaSupport: boolean;
    adapter: WebRTCAdapter;
}

/** Node.js entry point with runtime WebRTC adapter diagnostics. */
export declare class VDONinjaSDKNode extends VDONinja {
    readonly webrtcAdapter: WebRTCAdapter;

    getWebRTCInfo(): WebRTCInfo;
    static checkWebRTCSupport(): WebRTCSupport[];
}

export default VDONinjaSDKNode;
export {
    VDONinjaSDKNode as VDONinja,
    VDONinjaSDKNode as VDONinjaSDK
};

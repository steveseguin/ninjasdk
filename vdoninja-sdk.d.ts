/*
 * Copyright (c) 2025-2026 Steve Seguin. All rights reserved.
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// <reference lib="dom" />

// Type definitions for @vdoninja/sdk
// Project: https://github.com/steveseguin/ninjasdk
//
// These describe the SDK's public surface. Internal members (prefixed with _) are
// deliberately omitted: they are not part of the compatibility contract and change
// between releases. See docs/compatibility.md.

export as namespace VDONinjaSDK;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * `false` disables encryption entirely. `undefined`, `null`, and `""` all mean
 * "use the default password" — an empty string is not the same as `false`.
 */
export type Password = string | false | null;

export interface VDONinjaOptions {
    /** Signaling WebSocket URL. Default: wss://wss.vdo.ninja */
    host?: string;
    /** Room to join on connect. */
    room?: string;
    password?: Password;
    /** Hash salt. Must match the target deployment; "vdo.ninja" for vdo.ninja itself. */
    salt?: string;
    /** Human-readable label advertised to peers. */
    label?: string;
    /** Publisher metadata. Must be an object for VDO.Ninja to accept it. */
    meta?: Record<string, unknown> | string;
    debug?: boolean;
    /** null auto-fetches, false disables, or supply your own ICE servers. */
    turnServers?: RTCIceServer[] | null | false;
    stunServers?: RTCIceServer[] | null | false;
    forceTURN?: boolean;
    configuration?: RTCConfiguration;
    /** Recover failed peer directions automatically. Default: true */
    autoRecover?: boolean;
    /** Temporarily escalate failed direct paths to TURN. Default: true */
    autoRelay?: boolean;
    /** Grace period for temporary ICE disconnects, ms. Default: 5000 */
    disconnectGracePeriod?: number;
    /** Initial peer connection timeout, ms. Default: 20000 */
    connectionTimeout?: number;
    /** Wait between bounded recovery phases, ms. Default: 12000 */
    recoveryTimeout?: number;
    /** Restore direct-first ICE policy after recovery, ms. Default: 45000 */
    relayRestoreDelay?: number;
    /** Advertise willingness to receive the resources channel. */
    allowresources?: boolean;
    /** Advertise chunked media support. The SDK does not implement chunked media. */
    allowchunked?: boolean | number;
    [key: string]: unknown;
}

export interface MediaPreferences {
    video?: {
        codec?: string;
        maxBitrate?: number;
        resolution?: { width?: number; height?: number };
        frameRate?: number;
    };
    audio?: { codec?: string; maxBitrate?: number };
}

export interface PublishOptions {
    streamID?: string;
    room?: string;
    label?: string;
    password?: Password;
    media?: MediaPreferences;
    [key: string]: unknown;
}

export interface ViewOptions {
    audio?: boolean;
    video?: boolean;
    label?: string;
    /** Shorthand for { audio: false, video: false }. */
    dataOnly?: boolean;
    /**
     * Advertise willingness to receive file offers. Default true. VDO.Ninja publishers
     * only send their file list to a viewer that asked for it.
     */
    downloads?: boolean;
    /**
     * Advertise willingness to receive the `resources` channel. Default false, matching
     * VDO.Ninja, where it requires the &resources URL flag.
     */
    allowresources?: boolean;
    [key: string]: unknown;
}

/** Where to send data. Omit to broadcast to every connected peer. */
export type DataTarget =
    | string
    | {
          uuid?: string;
          type?: 'viewer' | 'publisher';
          streamID?: string;
          /** Data-channel routing. Default 'any': publisher first, then viewer. */
          preference?: 'any' | 'viewer' | 'publisher' | 'all';
          /** Use WebSocket signaling when no matching data channel is available. Default false. */
          allowFallback?: boolean;
      };

// ---------------------------------------------------------------------------
// File transfer and resources
// ---------------------------------------------------------------------------

export type FileSource = Blob | ArrayBuffer | ArrayBufferView;

export interface HostFileOptions {
    /** Required unless the source is a File. */
    name?: string;
    id?: string;
    /** A peer UUID to restrict the offer to, or false to offer it to everyone. */
    restricted?: string | false;
}

export interface HostedFile {
    id: string;
    name: string;
    size: number;
    restricted: string | false;
}

export interface AdvertisedFile {
    id: string;
    name: string;
    size: number;
}

export interface RequestFileOptions {
    /** Emit `fileChunk` events instead of buffering the whole file. */
    stream?: boolean;
    /** Milliseconds to wait for the peer to start sending. Default 30000. */
    timeout?: number;
}

export interface FileTransferResult {
    id: string;
    name: string;
    size: number;
    uuid: string;
    streamID: string | null;
    /** Absent in streaming mode. */
    bytes?: Uint8Array;
    /** Present only where Blob exists. */
    blob?: Blob;
}

export interface ChannelOptions {
    /** false allows out-of-order delivery. Default true. */
    ordered?: boolean;
    /** Partial reliability by retry count. Mutually exclusive with maxPacketLifeTime. */
    maxRetransmits?: number;
    /** Partial reliability by time in ms. Mutually exclusive with maxRetransmits. */
    maxPacketLifeTime?: number;
    protocol?: string;
    /** Milliseconds to wait for a newly created channel to open. Default 15000. */
    timeout?: number;
}

export interface ResourceMetadata {
    /** Key the receiver stores this resource under. */
    templateName: string;
    /** MIME type used to build the receiver's object URL. Defaults to image/png. */
    type?: string;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface PeerQuality {
    /** Round-trip time in milliseconds, or null if ICE has not reported one. */
    rttMs: number | null;
    /** 0..1 across inbound RTP. Null on a data-only peer, which carries no RTP. */
    lossRate: number | null;
    /** e.g. "host/srflx", "relay/host". Null if the candidate pair is unknown. */
    candidatePairType: string | null;
    relayed: boolean | null;
    availableOutgoingBitrate: number | null;
    bytesSent: number;
    bytesReceived: number;
}

export interface SDKState {
    connected: boolean;
    room: string | null;
    streamID: string | null;
    uuid: string | null;
    roomJoined: boolean;
    publishing: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface DisconnectedDetail {
    /** True when the local side asked to disconnect. */
    intentional: boolean;
    reason: 'local-disconnect' | 'socket-closed' | 'teardown-complete' | string;
    willReconnect: boolean;
    /** 'socket' fires when the socket closes; 'teardown' when cleanup is finished. */
    phase: 'socket' | 'teardown';
}

export interface FileTransferProgressDetail {
    uuid: string;
    streamID: string | null;
    id: string;
    name: string;
    direction: 'inbound' | 'outbound';
    bytes: number;
    size: number;
    progress: number;
}

/** OBS browser-source state received from a connected VDO.Ninja viewer. */
export interface OBSState {
    visibility?: boolean | null;
    sourceActive?: boolean | null;
    streaming?: boolean | null;
    recording?: boolean | null;
    virtualcam?: boolean | null;
    details?: Record<string, unknown> | null;
    [key: string]: unknown;
}

/**
 * Event payloads by name. Not exhaustive — see docs/api-reference.md for the full list.
 */
export interface VDONinjaEventMap {
    connected: undefined;
    disconnected: DisconnectedDetail;
    /** Emitted exactly once, when teardown genuinely finishes. */
    teardownComplete: { reason: string };
    reconnecting: unknown;
    reconnected: unknown;
    reconnectFailed: unknown;

    roomJoined: { room: string };
    roomLeft: { room: string };
    listing: { list: unknown[]; raw: unknown };

    peerConnected: { uuid: string; connection: unknown };
    peerDisconnected: { uuid: string };
    dataChannelOpen: { uuid: string; type: string; streamID: string | null };
    dataChannelClose: { uuid: string; type: string; streamID: string | null };
    peerInfo: { uuid: string; streamID: string | null; info: Record<string, unknown> };
    peerLatency: { uuid: string; latency: number; streamID: string | null };
    /** Sparse OBS update plus the SDK's merged state for this peer. */
    obsState: { uuid: string; streamID: string | null; state: OBSState; update: OBSState };

    dataReceived: { data: unknown; uuid: string; streamID?: string | null; fallback?: boolean };
    /** Long-standing misspelling, still emitted alongside dataReceived. */
    dataRecieved: { data: unknown; uuid: string; streamID?: string | null; fallback?: boolean };

    track: { track: MediaStreamTrack; streams?: MediaStream[]; uuid: string; streamID: string | null };

    fileList: { uuid: string; streamID: string | null; files: AdvertisedFile[] };
    fileTransferStart: {
        uuid: string; streamID: string | null; id: string; name: string;
        size: number; direction: 'inbound' | 'outbound'; requested: boolean;
    };
    fileTransferProgress: FileTransferProgressDetail;
    fileChunk: {
        uuid: string; streamID: string | null; id: string; name: string;
        chunk: Uint8Array; bytes: number; size: number;
    };
    fileTransferComplete: {
        uuid: string; id: string; name: string; size: number;
        direction: 'inbound' | 'outbound';
    };
    fileTransferCancelled: {
        uuid: string; id: string; name: string; direction: 'inbound' | 'outbound';
    };
    fileTransferError: {
        uuid: string; id: string; name?: string;
        direction: 'inbound' | 'outbound'; error: Error;
    };

    resourceReceived: {
        uuid: string; streamID: string | null;
        metadata: ResourceMetadata; bytes: Uint8Array;
    };

    /**
     * A peer opened a reserved `x-*` channel. The raw channel is handed over; the
     * application owns whatever protocol runs on it.
     */
    channelOpen: {
        uuid: string; streamID: string | null;
        label: string; channel: RTCDataChannel;
    };

    /** Raw bytes from a peer's sendBinary(). */
    binaryReceived: {
        uuid: string; streamID: string | null;
        bytes: Uint8Array | null; data: unknown;
    };

    /** A channel's send buffer drained below its low-water mark. */
    bufferedAmountLow: {
        uuid: string; streamID: string | null;
        label: string; bufferedAmount: number;
    };

    /** A peer opened an auxiliary channel this build does not speak. */
    unsupportedChannel: { uuid: string; streamID: string | null; label: string };
}

export interface VDONinjaEvent<K extends keyof VDONinjaEventMap> extends CustomEvent {
    detail: VDONinjaEventMap[K];
}

// ---------------------------------------------------------------------------
// SDK
// ---------------------------------------------------------------------------

export declare class VDONinja extends EventTarget {
    constructor(options?: VDONinjaOptions);

    readonly state: SDKState;
    readonly connections: Map<string, Record<string, unknown>>;
    readonly streams: Map<string, unknown>;

    // -- Connection ---------------------------------------------------------
    connect(options?: Record<string, unknown>): Promise<void>;
    /** Resolves once teardown genuinely completes. Safe to call more than once. */
    disconnect(): Promise<void>;
    joinRoom(options: { room: string; password?: Password }): Promise<void>;
    leaveRoom(): void;
    autoConnect(
        roomOrOptions: string | Record<string, unknown>,
        filter?: (peer: unknown) => boolean
    ): Promise<{ stop: () => void; streamID: string }>;

    // -- Publishing ---------------------------------------------------------
    publish(stream: MediaStream, options?: PublishOptions): Promise<string>;
    announce(options?: PublishOptions): Promise<string>;
    stopPublishing(): void;
    updatePublisherMedia(options: {
        media?: MediaPreferences;
        videoBitrate?: number;
        videoCodec?: string;
        clear?: boolean;
    }): Promise<Record<string, unknown> | null>;
    addTrack(track: MediaStreamTrack, stream?: MediaStream): Promise<void>;
    removeTrack(track: MediaStreamTrack): Promise<void>;
    replaceTrack(oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack): Promise<void>;

    // -- Viewing ------------------------------------------------------------
    view(streamID: string, options?: ViewOptions): Promise<RTCPeerConnection>;
    stopViewing(streamID: string): void;

    // -- Quick helpers ------------------------------------------------------
    quickPublish(options: PublishOptions & { stream?: MediaStream }): Promise<string>;
    quickView(options: ViewOptions & { streamID: string; room?: string }): Promise<RTCPeerConnection>;
    quickSubscribe(options?: ViewOptions & { streamID?: string; room?: string }): Promise<RTCPeerConnection>;

    // -- Data ---------------------------------------------------------------
    sendData(data: unknown, target?: DataTarget): boolean;
    sendPing(uuid?: string): boolean;
    request(requestType: string, data: unknown, targetUUID: string, timeout?: number): Promise<unknown>;
    respond(requestId: string, data: unknown, targetUUID: string): boolean;
    onRequest(requestType: string, handler: (data: unknown, uuid: string) => unknown): void;

    // -- Pub/sub ------------------------------------------------------------
    subscribe(channels: string | string[]): void;
    unsubscribe(channels: string | string[]): void;
    getSubscriptions(): string[];
    publishToChannel(channel: string, data: unknown, target?: DataTarget | 'all'): boolean;
    getPeerSubscriptions(uuid: string): string[];

    // -- File transfer ------------------------------------------------------
    hostFile(source: FileSource, options?: HostFileOptions): AdvertisedFile;
    unhostFile(id: string): boolean;
    getHostedFiles(): HostedFile[];
    requestFile(uuid: string, fileId: string, options?: RequestFileOptions): Promise<FileTransferResult>;

    // -- Resources ----------------------------------------------------------
    sendResource(uuid: string, metadata: ResourceMetadata, data: ArrayBuffer | ArrayBufferView): Promise<void>;

    // -- Binary and additional channels -------------------------------------
    /**
     * Send raw bytes over a dedicated reserved channel. Never uses the control channel:
     * VDO.Ninja renders binary there as a WebP image.
     */
    sendBinary(
        data: ArrayBuffer | ArrayBufferView,
        uuid: string,
        options?: ChannelOptions & { waitForDrain?: boolean }
    ): Promise<boolean>;
    /** Open an additional channel. The label is forced into the reserved `x-` namespace. */
    openChannel(uuid: string, label: string, options?: ChannelOptions): Promise<RTCDataChannel>;
    getChannel(uuid: string, label: string): RTCDataChannel | null;
    /** Omit `label` for the control channel. Null if the peer or channel is unknown. */
    getBufferedAmount(uuid: string, label?: string): number | null;
    /** Negotiated SCTP limit, or null if the transport has not reported one. */
    getMaxMessageSize(uuid: string): number | null;

    // -- Diagnostics --------------------------------------------------------
    getStats(uuid?: string): Promise<Record<string, unknown>>;
    /** Digested per-peer quality. Null if the peer is unknown. */
    getPeerQuality(uuid: string): Promise<PeerQuality | null>;
    getStreams(): unknown[];
    getStreamInfo(streamID: string): unknown;
    clearTURNCache(): void;

    // -- Typed event helpers ------------------------------------------------
    on<K extends keyof VDONinjaEventMap>(event: K, handler: (e: VDONinjaEvent<K>) => void): this;
    on(event: string, handler: EventListenerOrEventListenerObject): this;
    off<K extends keyof VDONinjaEventMap>(event: K, handler: (e: VDONinjaEvent<K>) => void): this;
    off(event: string, handler: EventListenerOrEventListenerObject): this;
    once<K extends keyof VDONinjaEventMap>(event: K, handler: (e: VDONinjaEvent<K>) => void): this;
    once(event: string, handler: EventListenerOrEventListenerObject): this;

    // -- Aliases ------------------------------------------------------------
    play(streamID: string, options?: ViewOptions): Promise<RTCPeerConnection>;
    watch(streamID: string, options?: ViewOptions): Promise<RTCPeerConnection>;
    startViewing(streamID: string, options?: ViewOptions): Promise<RTCPeerConnection>;
    stop(streamID: string): void;
    stopPlaying(streamID: string): void;
    stopWatching(streamID: string): void;

    stream(stream: MediaStream, options?: PublishOptions): Promise<string>;
    broadcast(stream: MediaStream, options?: PublishOptions): Promise<string>;
    startPublishing(stream: MediaStream, options?: PublishOptions): Promise<string>;
    share(stream: MediaStream, options?: PublishOptions): Promise<string>;
    stopStreaming(): void;
    stopBroadcasting(): void;
    stopSharing(): void;
    unpublish(): void;

    quickStream(options: PublishOptions & { stream?: MediaStream }): Promise<string>;
    quickBroadcast(options: PublishOptions & { stream?: MediaStream }): Promise<string>;
    quickShare(options: PublishOptions & { stream?: MediaStream }): Promise<string>;
    quickPlay(options: ViewOptions & { streamID: string }): Promise<RTCPeerConnection>;
    quickWatch(options: ViewOptions & { streamID: string }): Promise<RTCPeerConnection>;

    join(options: { room: string; password?: Password }): Promise<void>;
    enterRoom(options: { room: string; password?: Password }): Promise<void>;
    enter(options: { room: string; password?: Password }): Promise<void>;
    leave(): void;
    exitRoom(): void;
    exit(): void;
}

export default VDONinja;
export { VDONinja as VDONinjaSDK };

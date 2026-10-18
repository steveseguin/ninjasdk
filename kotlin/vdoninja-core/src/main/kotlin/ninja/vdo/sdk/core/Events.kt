/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import org.json.JSONObject

/** Event names, identical to the JavaScript SDK. */
object VdoEvents {
    const val CONNECTED = "connected"
    const val DISCONNECTED = "disconnected"
    const val RECONNECTING = "reconnecting"
    const val RECONNECTED = "reconnected"
    const val RECONNECT_FAILED = "reconnectFailed"
    const val ROOM_JOINED = "roomJoined"
    const val ROOM_LEFT = "roomLeft"
    const val LISTING = "listing"
    const val VIDEO_ADDED_TO_ROOM = "videoaddedtoroom"
    const val SOMEONE_JOINED = "someoneJoined"
    const val TRANSFERRED = "transferred"
    const val PUBLISHING = "publishing"
    const val PUBLISHING_STOPPED = "publishingStopped"
    const val VIEWING_STOPPED = "viewingStopped"
    const val PEER_CONNECTED = "peerConnected"
    const val PEER_DISCONNECTED = "peerDisconnected"
    const val CONNECTION_FAILED = "connectionFailed"
    const val ICE_RESTART = "iceRestart"
    const val DATA_CHANNEL_OPEN = "dataChannelOpen"
    const val DATA_CHANNEL_CLOSE = "dataChannelClose"
    const val DATA_RECEIVED = "dataReceived"
    const val PEER_INFO = "peerInfo"
    const val PEER_LATENCY = "peerLatency"
    const val REMOTE_VIDEO_MUTE_STATE = "remoteVideoMuteState"
    const val OBS_STATE = "obsState"
    const val TRACK = "track"
    const val CHANNEL_MESSAGE = "channelMessage"
    const val PEER_SUBSCRIBED = "peerSubscribed"
    const val PEER_UNSUBSCRIBED = "peerUnsubscribed"
    const val BINARY_RECEIVED = "binaryReceived"
    const val BYE = "bye"
    const val HANGUP = "hangup"
    const val ALERT = "alert"
    const val ERROR = "error"
}

/** An SDK event. Only the fields relevant to [type] are set. */
class VdoEvent(
    val type: String,
    val uuid: String? = null,
    val streamId: String? = null,
    /** "publisher" or "viewer". */
    val connectionType: String? = null,
    /** Decoded JSON payload: JSONObject, JSONArray, String, Number, Boolean or null. */
    val data: Any? = null,
    val message: String? = null,
    /** Pub/sub channel or data channel label. */
    val channel: String? = null,
    val latencyMs: Long? = null,
    val attempt: Int? = null,
    val muted: Boolean? = null,
    val intentional: Boolean = false,
    val fallback: Boolean = false,
    /** Engine-specific track (`org.webrtc.MediaStreamTrack` on Android). */
    val track: Any? = null,
    /** Engine-specific stream, when the engine groups tracks. */
    val stream: Any? = null,
    val bytes: ByteArray? = null,
    /** The raw signaling or control message, when applicable. */
    val raw: JSONObject? = null,
) {
    override fun toString(): String = "VdoEvent($type${uuid?.let { ", uuid=$it" } ?: ""}${message?.let { ", $it" } ?: ""})"
}

fun interface VdoEventListener {
    fun onEvent(event: VdoEvent)
}

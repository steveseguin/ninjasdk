# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Asyncio VDO.Ninja SDK built on aiortc.

The wire protocol (hashed room/stream IDs, AES-CBC encrypted SDP and ICE, the
``sendChannel`` control channel, publisher/viewer roles, ping/pong, pub/sub,
request/response and native file transfer) matches the JavaScript SDK, so a
Python process interoperates with VDO.Ninja browser pages and the other SDKs.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
import uuid as uuid_module
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Union

import websockets
from aiortc import (
    RTCConfiguration,
    RTCDataChannel,
    RTCIceServer,
    RTCPeerConnection,
    RTCRtpSender,
    RTCSessionDescription,
)
from aiortc.mediastreams import MediaStreamTrack
from aiortc.sdp import candidate_from_sdp

from . import turn as turn_module
from .crypto import (
    decrypt_message,
    encrypt_message,
    generate_session,
    generate_stream_id,
    hash_room,
    stream_hash_suffix,
)
from .sanitize import (
    sanitize_label,
    sanitize_meta,
    sanitize_password,
    sanitize_room,
    sanitize_stream_id,
)

log = logging.getLogger("vdoninja")

DEFAULT_HOST = "wss://wss.vdo.ninja"
DEFAULT_PASSWORD = "someEncryptionKey123"
DEFAULT_SALT = "vdo.ninja"
DEFAULT_STUN_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"]

CONTROL_CHANNEL = "sendChannel"
CHUNKED_CHANNEL = "chunked"
RESOURCES_CHANNEL = "resources"
RESERVED_PREFIX = "x-"
BINARY_CHANNEL = "x-bin"
FILE_CHUNK_SIZE = 16384
FILE_EOF_COMPLETE = "EOF1"
FILE_EOF_CANCELLED = "EOF2"
BUFFER_HIGH = 1_048_576
SIGNALING_QUEUE_LIMIT = 30


class VDONinjaError(Exception):
    """Base error."""


class StreamNotYetAvailable(VDONinjaError):
    """``view()`` timed out waiting for the publisher; the request stays pending."""


@dataclass
class Event:
    """An SDK event. Only the fields relevant to ``type`` are set."""

    type: str
    uuid: Optional[str] = None
    stream_id: Optional[str] = None
    connection_type: Optional[str] = None
    data: Any = None
    raw: Optional[Dict[str, Any]] = None
    message: Optional[str] = None
    error: Optional[BaseException] = None
    info: Optional[Dict[str, Any]] = None
    latency: Optional[int] = None
    muted: Optional[bool] = None
    track: Optional[MediaStreamTrack] = None
    channel: Optional[RTCDataChannel] = None
    label: Optional[str] = None
    bytes: Optional[bytes] = None
    file: Optional[Dict[str, Any]] = None
    files: Optional[List["FileEntry"]] = None
    list: Optional[List[Dict[str, Any]]] = None
    channels: Optional[List[str]] = None
    channel_name: Optional[str] = None
    timestamp: Optional[int] = None
    intentional: Optional[bool] = None
    will_reconnect: Optional[bool] = None
    reason: Optional[str] = None
    fallback: bool = False


@dataclass
class FileEntry:
    id: str
    name: str
    size: int


@dataclass
class FileResult:
    id: str
    name: str
    size: int
    uuid: str
    stream_id: Optional[str]
    data: Optional[bytes]


@dataclass
class PeerQuality:
    rtt_ms: Optional[float] = None
    candidate_pair_type: Optional[str] = None
    relayed: bool = False
    bytes_sent: int = 0
    bytes_received: int = 0
    packets_lost: int = 0
    packets_received: int = 0


@dataclass
class _ViewOptions:
    audio: bool = True
    video: bool = True
    label: str = ""
    downloads: bool = True
    allowresources: bool = False
    timeout: float = 15.0


class Connection:
    """One WebRTC connection in one direction (``publisher`` or ``viewer``)."""

    def __init__(self, sdk: "VDONinja", uuid: str, kind: str, pc: RTCPeerConnection):
        self.sdk = sdk
        self.uuid = uuid
        self.type = kind
        self.pc = pc
        self.control: Optional[RTCDataChannel] = None
        self.channels: Dict[str, RTCDataChannel] = {}
        self.stream_id: Optional[str] = None
        self.session: Optional[str] = None
        self.info: Dict[str, Any] = {}
        self.obs_state: Dict[str, Any] = {}
        self.info_sent = False
        self.media_lock = asyncio.Lock()
        self.allow_audio = False
        self.allow_video = False
        self.allow_downloads = False
        self.allow_resources = False
        self.view_options = _ViewOptions()
        self.senders: List[RTCRtpSender] = []
        self.pending_ping: Optional[int] = None
        self.missed_pings = 0
        self.ping_task: Optional[asyncio.Task] = None
        self.connect_task: Optional[asyncio.Task] = None
        self.disconnect_task: Optional[asyncio.Task] = None
        self.connected_once = False
        self.finalized = False
        self.recovering = False
        self.advertised: set = set()
        self.last_message = time.time()

    @property
    def control_open(self) -> bool:
        return self.control is not None and self.control.readyState == "open"

    def send_control(self, message: Dict[str, Any]) -> bool:
        """Send a JSON message on the control channel; False when it is not open."""
        if not self.control_open:
            return False
        text = json.dumps(message, separators=(",", ":"))
        log.debug("-> DC(%s/%s) %s", self.uuid, self.type, text[:300])
        try:
            self.control.send(text)  # type: ignore[union-attr]
            return True
        except Exception:  # noqa: BLE001
            return False

    async def close(self) -> None:
        self.finalized = True
        for task in (self.ping_task, self.connect_task, self.disconnect_task):
            if task:
                task.cancel()
        try:
            await self.pc.close()
        except Exception:  # noqa: BLE001
            pass


class _PeerPair:
    def __init__(self) -> None:
        self.publisher: Optional[Connection] = None
        self.viewer: Optional[Connection] = None

    def get(self, kind: str) -> Optional[Connection]:
        return self.publisher if kind == "publisher" else self.viewer

    def set(self, kind: str, conn: Optional[Connection]) -> None:
        if kind == "publisher":
            self.publisher = conn
        else:
            self.viewer = conn

    @property
    def empty(self) -> bool:
        return self.publisher is None and self.viewer is None


Handler = Callable[[Event], Union[None, Awaitable[None]]]


class VDONinja:
    """A VDO.Ninja peer.

    Create one, register handlers with :meth:`on`, then ``await connect()``,
    ``join_room()``, ``publish()``/``announce()`` and ``view()``.
    """

    def __init__(
        self,
        host: str = DEFAULT_HOST,
        *,
        room: Optional[str] = None,
        password: Union[str, bool, None] = None,
        salt: str = DEFAULT_SALT,
        label: str = "",
        meta: Any = None,
        order: str = "",
        info: Optional[Dict[str, Any]] = None,
        turn: Union[str, bool, List[RTCIceServer]] = "auto",
        turn_url: str = turn_module.DEFAULT_TURN_URL,
        turn_cache_ttl: float = 300.0,
        force_tcp: bool = False,
        stun_servers: Optional[List[str]] = None,
        max_reconnect_attempts: int = 5,
        reconnect_delay: float = 1.0,
        connection_timeout: float = 20.0,
        disconnect_grace_period: float = 5.0,
        view_retry_interval: float = 900.0,
        auto_ping_viewer: bool = False,
        auto_ping_interval: float = 10.0,
    ) -> None:
        """
        :param host: signaling WebSocket URL.
        :param password: original password text; ``None``/``""`` uses the shared
            default, ``False`` disables hashing and encryption entirely.
        :param salt: must match the viewer's domain salt (``vdo.ninja`` for vdo.ninja).
        :param turn: ``"auto"`` fetches the hosted TURN list, ``False`` disables TURN,
            or pass a list of :class:`aiortc.RTCIceServer`.
        :param stun_servers: STUN URLs; ``[]`` disables STUN.
        """
        self.host = host
        self.salt = salt or DEFAULT_SALT
        self.room: str = sanitize_room(room) if room else ""
        self.no_password = password is False
        if password is False or password is None or password == "":
            self.password = "" if password is False else sanitize_password(DEFAULT_PASSWORD)
        else:
            self.password = sanitize_password("true" if password is True else str(password))
        self.turn = turn
        self.turn_url = turn_url
        self.turn_cache_ttl = turn_cache_ttl
        self.force_tcp = force_tcp
        self.stun_servers = DEFAULT_STUN_SERVERS if stun_servers is None else stun_servers
        self.max_reconnect_attempts = max_reconnect_attempts
        self.reconnect_delay = reconnect_delay
        self.connection_timeout = connection_timeout
        self.disconnect_grace_period = disconnect_grace_period
        self.view_retry_interval = view_retry_interval
        self.auto_ping_viewer = auto_ping_viewer
        self.auto_ping_interval = max(1.0, auto_ping_interval)

        self.publisher_info: Dict[str, Any] = {}
        self._set_publisher_info(label, meta, order, info)

        self._handlers: Dict[str, List[Handler]] = {}
        self._any_handlers: List[Handler] = []
        self._ws = None
        self._ws_task: Optional[asyncio.Task] = None
        self._reconnect_task: Optional[asyncio.Task] = None
        self._connected = False
        self._intentional = False
        self._generation = 0
        self._reconnects = 0
        self._reconnecting = False
        self._queue: List[str] = []

        self.room_joined = False
        self._room_waiters: List[asyncio.Future] = []
        self._intent_room: Optional[Dict[str, Any]] = None
        self.publishing = False
        self._data_only = False
        self.stream_id: Optional[str] = None
        self._local_tracks: List[MediaStreamTrack] = []

        self.connections: Dict[str, _PeerPair] = {}
        self._pending_views: Dict[str, _ViewOptions] = {}
        self._view_intent: Dict[str, _ViewOptions] = {}
        self._stopped_views: set = set()
        self._view_retry_tasks: Dict[str, asyncio.Task] = {}
        self._view_waiters: Dict[str, List[asyncio.Future]] = {}
        self.streams: Dict[str, Dict[str, Any]] = {}
        self._pending_ice: Dict[str, List[Dict[str, Any]]] = {}

        self._subscriptions: set = set()
        self._peer_subs: Dict[str, set] = {}
        self._pending_requests: Dict[str, Dict[str, Any]] = {}
        self._request_handlers: Dict[str, Callable] = {}

        self._hosted_files: Dict[str, Dict[str, Any]] = {}
        self._inbound: Dict[str, Dict[str, Any]] = {}

        self._turn_list: Optional[List[RTCIceServer]] = None
        self._turn_fetched = 0.0
        self._tasks: set = set()

    # ------------------------------------------------------------------ events

    def on(self, event: str, handler: Handler) -> Callable[[], None]:
        """Register a handler (sync or async). Returns a function that removes it."""
        self._handlers.setdefault(event, []).append(handler)

        def off() -> None:
            try:
                self._handlers[event].remove(handler)
            except (KeyError, ValueError):
                pass

        return off

    def on_any(self, handler: Handler) -> Callable[[], None]:
        self._any_handlers.append(handler)
        return lambda: self._any_handlers.remove(handler)

    async def wait_for(self, event: str, predicate: Optional[Callable[[Event], bool]] = None, timeout: Optional[float] = None) -> Event:
        """Wait for the next event of a type (optionally matching ``predicate``)."""
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()

        def handler(ev: Event) -> None:
            if not fut.done() and (predicate is None or predicate(ev)):
                fut.set_result(ev)

        off = self.on(event, handler)
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            off()

    def _emit(self, ev: Event) -> None:
        for handler in list(self._handlers.get(ev.type, [])) + list(self._any_handlers):
            try:
                result = handler(ev)
                if inspect.isawaitable(result):
                    self._spawn(result)
            except Exception:  # noqa: BLE001
                log.exception("event handler for %s failed", ev.type)

    def _spawn(self, coro: Awaitable[Any]) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    # ------------------------------------------------------------------ crypto

    def _effective_password(self) -> Optional[str]:
        if self.no_password:
            return None
        return self.password or sanitize_password(DEFAULT_PASSWORD)

    @property
    def password_hash(self) -> str:
        pw = self._effective_password()
        return "" if pw is None else stream_hash_suffix(pw, self.salt)

    def _phrase(self) -> Optional[str]:
        pw = self._effective_password()
        return None if pw is None else pw + self.salt

    def _encrypt(self, value: Any):
        phrase = self._phrase()
        if phrase is None:
            raise VDONinjaError("password encryption disabled")
        return encrypt_message(json.dumps(value, separators=(",", ":")), phrase)

    def _decrypt(self, ciphertext: str, iv: str) -> Any:
        phrase = self._phrase()
        if phrase is None:
            raise VDONinjaError("password encryption disabled")
        return json.loads(decrypt_message(ciphertext, iv, phrase))

    def hashed_stream_id(self, stream_id: str) -> str:
        return stream_id if self.no_password else stream_id + self.password_hash

    def _strip_hash(self, stream_id: Optional[str]) -> Optional[str]:
        if not stream_id or self.no_password:
            return stream_id
        suffix = self.password_hash
        if suffix and len(stream_id) > len(suffix) and stream_id.endswith(suffix):
            return stream_id[: -len(suffix)]
        return stream_id

    def _set_publisher_info(self, label: str, meta: Any, order: str, info: Optional[Dict[str, Any]]) -> None:
        if label:
            self.publisher_info["label"] = sanitize_label(label)
        if meta is not None:
            safe = sanitize_meta(meta)
            if safe:
                self.publisher_info["meta"] = safe
        if order:
            self.publisher_info["order"] = sanitize_label(order)
        for key, value in (info or {}).items():
            if key in ("broadcast", "allowdrawing", "iframe", "widget", "allowmidi", "allowresources") and isinstance(value, bool):
                self.publisher_info[key] = value
            elif key == "allowchunked" and isinstance(value, (bool, int)):
                self.publisher_info[key] = value
            elif key == "label" and isinstance(value, str):
                self.publisher_info["label"] = sanitize_label(value)
            elif key == "meta":
                safe = sanitize_meta(value)
                if safe:
                    self.publisher_info["meta"] = safe
            elif key == "order" and isinstance(value, str):
                self.publisher_info["order"] = sanitize_label(value)

    # ------------------------------------------------------------- signaling

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        """Open the signaling WebSocket."""
        if self._connected:
            return
        self._intentional = False
        generation = self._generation
        ws = await websockets.connect(self.host, max_size=4 * 1024 * 1024)
        if generation != self._generation or self._intentional:
            await ws.close()
            raise VDONinjaError("operation cancelled by disconnect")
        self._ws = ws
        self._connected = True
        if not self._reconnecting:
            self._reconnects = 0
        queued, self._queue = self._queue, []
        for text in queued:
            await ws.send(text)
        log.debug("WebSocket connected to %s", self.host)
        self._emit(Event("connected"))
        self._ws_task = asyncio.ensure_future(self._read_loop(ws, generation))

    async def _read_loop(self, ws, generation: int) -> None:
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", "replace")
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                log.debug("<- WS %s", raw[:300])
                try:
                    await self._handle_signaling(msg)
                except Exception:  # noqa: BLE001
                    log.exception("signaling handler failed")
        except Exception:  # noqa: BLE001
            pass
        if self._ws is not ws or generation != self._generation:
            return
        self._ws = None
        self._connected = False
        self.room_joined = False
        self.publishing = False
        intentional = self._intentional
        will_reconnect = not intentional and self._reconnects < self.max_reconnect_attempts
        if not intentional:
            self._emit(Event("disconnected", intentional=False, reason="socket-closed", will_reconnect=will_reconnect))
            if will_reconnect:
                self._reconnect_task = asyncio.ensure_future(self._reconnect(generation))

    async def _reconnect(self, generation: int) -> None:
        self._reconnecting = True
        try:
            await self._reconnect_loop(generation)
        finally:
            self._reconnecting = False

    async def _reconnect_loop(self, generation: int) -> None:
        while True:
            if self._intentional or generation != self._generation or self._connected:
                return
            if self._reconnects >= self.max_reconnect_attempts:
                self._emit(Event("reconnectFailed", message="max reconnect attempts reached"))
                return
            self._reconnects += 1
            delay = min(30.0, self.reconnect_delay * (2 ** (self._reconnects - 1)))
            self._emit(Event("reconnecting", message=f"attempt {self._reconnects}"))
            await asyncio.sleep(delay)
            try:
                await asyncio.wait_for(self.connect(), 20)
            except Exception as exc:  # noqa: BLE001
                log.debug("reconnect attempt %d failed: %s", self._reconnects, exc)
                continue
            await self._restore_intent()
            self._reconnects = 0
            self._emit(Event("reconnected"))
            return

    async def _restore_intent(self) -> None:
        room = self._intent_room
        stream_id = self.stream_id
        was_publishing = stream_id is not None and (self._data_only or bool(self._local_tracks))
        views = {k: v for k, v in self._view_intent.items() if k not in self._stopped_views}
        try:
            if room:
                await self.join_room(room["room"], claim=room.get("claim", False))
            if was_publishing and stream_id:
                # Re-seed directly: announce()/publish() refuse a second publish per connection.
                if self._intentional or not self._connected or self.stream_id != stream_id:
                    return
                self.publishing = True
                self._send_ws({"request": "seed", "streamID": self.hashed_stream_id(stream_id)})
        except Exception as exc:  # noqa: BLE001
            log.debug("restore intent failed: %s", exc)
        for sid, opts in views.items():
            self._spawn(self._view_quiet(sid, opts))

    async def _view_quiet(self, stream_id: str, opts: _ViewOptions) -> None:
        try:
            await self._view(stream_id, opts)
        except Exception:  # noqa: BLE001
            pass

    async def disconnect(self) -> None:
        """Send bye to peers, close everything and emit a single disconnected event."""
        self._intentional = True
        self._generation += 1
        ws, self._ws = self._ws, None
        self._connected = False
        self.room_joined = False
        self.publishing = False
        self._queue = []
        for task in list(self._view_retry_tasks.values()):
            task.cancel()
        self._view_retry_tasks = {}
        if self._reconnect_task:
            self._reconnect_task.cancel()
        conns, self.connections = self.connections, {}
        self._pending_views = {}
        self._pending_ice = {}
        # An explicit disconnect drops the connection intent, as the JS SDK does:
        # a later connect() starts clean, and an unexpected drop after it must
        # not replay the old room, stream or views.
        self.stream_id = None
        self._data_only = False
        self._local_tracks = []
        self._intent_room = None
        self._view_intent = {}
        self._stopped_views = set()
        self._reconnects = 0
        for transfer in self._inbound.values():
            fut = transfer["future"]
            if not fut.done():
                fut.set_exception(VDONinjaError("operation cancelled by disconnect"))
        self._inbound = {}
        for fut in self._room_waiters:
            if not fut.done():
                fut.set_exception(VDONinjaError("operation cancelled by disconnect"))
        self._room_waiters = []
        for waiters in self._view_waiters.values():
            for fut in waiters:
                if not fut.done():
                    fut.set_exception(VDONinjaError("operation cancelled by disconnect"))
        self._view_waiters = {}
        for pending in self._pending_requests.values():
            fut = pending["future"]
            if not fut.done():
                fut.set_exception(VDONinjaError("operation cancelled by disconnect"))
        self._pending_requests = {}
        await self._close_with_bye([c for pair in conns.values() for c in (pair.publisher, pair.viewer) if c])
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass
        self._emit(Event("disconnected", intentional=True, reason="local-disconnect"))

    async def _close_with_bye(self, conns: List[Connection]) -> None:
        """Sends bye, waits briefly (up to 100 ms, like the JS bufferedAmount wait) for it to
        leave the control channel, then closes the peer connections."""
        for conn in conns:
            conn.send_control({"bye": True})
        if conns:
            await asyncio.sleep(0.02)
            deadline = time.time() + 0.08
            while time.time() < deadline and any(
                c.control is not None and c.control.readyState == "open" and c.control.bufferedAmount > 0 for c in conns
            ):
                await asyncio.sleep(0.01)
        for conn in conns:
            await conn.close()

    def _send_ws(self, msg: Dict[str, Any]) -> bool:
        text = json.dumps(msg, separators=(",", ":"))
        log.debug("-> WS %s", text[:300])
        ws = self._ws
        if ws is None:
            if self._intentional:
                return False
            self._queue.append(text)
            self._queue = self._queue[-SIGNALING_QUEUE_LIMIT:]
            return True
        self._spawn(self._ws_send(ws, text))
        return True

    async def _ws_send(self, ws, text: str) -> None:
        try:
            await ws.send(text)
        except Exception as exc:  # noqa: BLE001
            log.debug("WebSocket send failed: %s", exc)

    # ----------------------------------------------------------------- rooms

    async def join_room(self, room: Optional[str] = None, password: Union[str, bool, None] = None, claim: bool = False, timeout: float = 10.0) -> None:
        """Join and wait for the listing. None inherits the instance password;
        False disables it; empty/whitespace strings reset the shared default.
        """
        if not self._connected:
            raise VDONinjaError("not connected to signaling server")
        if self.room_joined:
            log.debug("already joined a room on this connection")
            return
        generation = self._generation
        room = sanitize_room(room) or self.room
        if not room:
            raise VDONinjaError("room name is required")
        if password is not None:
            self.no_password = password is False
            self.password = "" if self.no_password else sanitize_password("true" if password is True else str(password))
        self._intent_room = {"room": room, "claim": claim}
        pw = self._effective_password()
        hashed = hash_room(room, pw, self.salt) if pw is not None else room
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._room_waiters.append(fut)
        msg: Dict[str, Any] = {"request": "joinroom", "roomid": hashed}
        if claim:
            msg["claim"] = True
        log.debug("joining room %r as %r", room, hashed)
        self._send_ws(msg)
        try:
            await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            if fut in self._room_waiters:
                self._room_waiters.remove(fut)
            raise VDONinjaError("room join timeout")
        if generation != self._generation or self._intentional:
            raise VDONinjaError("operation cancelled by disconnect")
        self.room = room
        self.room_joined = True
        self._emit(Event("roomJoined", data=room))

    async def leave_room(self) -> None:
        """Disconnect peers and signaling to leave; reconnect before joining again."""
        room = self.room
        self.room = ""
        self.room_joined = False
        self._intent_room = None
        if room:
            await self.disconnect()
            self._emit(Event("roomLeft", data=room))

    # ------------------------------------------------------------ publishing

    async def announce(self, stream_id: Optional[str] = None, *, room: Optional[str] = None, password: Union[str, bool, None] = None, label: str = "", meta: Any = None, order: str = "", info: Optional[Dict[str, Any]] = None) -> str:
        """Register a data-only stream so peers can connect to it. Returns the stream ID."""
        return await self._seed(None, True, stream_id, room, password, label, meta, order, info)

    async def publish(self, tracks: List[MediaStreamTrack], stream_id: Optional[str] = None, *, room: Optional[str] = None, password: Union[str, bool, None] = None, label: str = "", meta: Any = None, order: str = "", info: Optional[Dict[str, Any]] = None) -> str:
        """Register a media stream. ``tracks`` are aiortc MediaStreamTrack objects."""
        return await self._seed(tracks, False, stream_id, room, password, label, meta, order, info)

    async def _seed(self, tracks, data_only, stream_id, room, password, label, meta, order, info) -> str:
        if not self._connected:
            raise VDONinjaError("not connected to signaling server")
        if self.publishing:
            # One publish per signaling connection, like the JavaScript SDK.
            raise VDONinjaError("already publishing on this connection; disconnect and reconnect to publish a different stream")
        generation = self._generation
        self._set_publisher_info(label, meta, order, info)
        sid = sanitize_stream_id(stream_id) if stream_id else (self.stream_id or generate_stream_id())
        if not self.room_joined and room:
            await self.join_room(room, password)
        if generation != self._generation or self._intentional:
            raise VDONinjaError("operation cancelled by disconnect")
        hashed = self.hashed_stream_id(sid)
        self.stream_id = sid
        self.publishing = True
        self._data_only = data_only
        if not data_only:
            self._local_tracks = list(tracks or [])
        now = time.time()
        self.streams[sid] = {"streamID": sid, "state": "connected", "firstSeen": now, "lastSeen": now, "uuid": None}
        log.debug("seeding %r as %r (data_only=%s)", sid, hashed, data_only)
        self._send_ws({"request": "seed", "streamID": hashed})
        self._emit(Event("publishing", stream_id=sid, data={"hashedStreamID": hashed, "dataOnly": data_only}))
        return sid

    async def stop_publishing(self) -> None:
        if not self.publishing and self.stream_id is None:
            return
        sid = self.stream_id
        self.publishing = False
        self.stream_id = None
        self._local_tracks = []
        closing = []
        for uuid, pair in list(self.connections.items()):
            if pair.publisher:
                closing.append(pair.publisher)
                pair.publisher = None
            if pair.empty:
                del self.connections[uuid]
        await self._close_with_bye(closing)
        self._emit(Event("publishingStopped", stream_id=sid))

    async def add_track(self, track: MediaStreamTrack) -> None:
        """Add a track to an active media publish and renegotiate every publisher connection."""
        if not self.publishing or self._data_only:
            raise VDONinjaError("not publishing media")
        self._local_tracks.append(track)
        for pair in list(self.connections.values()):
            conn = pair.publisher
            if not conn or not conn.info_sent or not conn.control_open:
                continue
            if (track.kind == "audio" and not conn.allow_audio) or (track.kind == "video" and not conn.allow_video):
                continue
            conn.senders.append(conn.pc.addTrack(track))
            await self._renegotiate(conn)

    # --------------------------------------------------------------- viewing

    async def view(self, stream_id: str, *, audio: bool = True, video: bool = True, label: str = "", downloads: bool = True, allowresources: bool = False, timeout: float = 15.0) -> Connection:
        """Request a stream and return the viewer connection once the offer is answered.

        Raises :class:`StreamNotYetAvailable` after ``timeout`` seconds while
        keeping the request pending; the stream connects automatically when it
        appears in the room (a ``dataChannelOpen``/``track`` event follows).
        """
        opts = _ViewOptions(audio=audio, video=video, label=sanitize_label(label), downloads=downloads, allowresources=allowresources, timeout=timeout)
        return await self._view(sanitize_stream_id(stream_id), opts)

    async def _view(self, stream_id: str, opts: _ViewOptions) -> Connection:
        if not self._connected:
            raise VDONinjaError("not connected to signaling server")
        generation = self._generation
        hashed = self.hashed_stream_id(stream_id)
        now = time.time()
        info = self.streams.setdefault(stream_id, {"streamID": stream_id, "firstSeen": now, "uuid": None, "state": "pending"})
        info["lastSeen"] = now
        info["state"] = "pending"
        self._view_intent[stream_id] = opts
        self._stopped_views.discard(stream_id)
        self._pending_views[stream_id] = opts
        task = self._view_retry_tasks.pop(stream_id, None)
        if task:
            task.cancel()
        for pair in self.connections.values():
            if pair.viewer and pair.viewer.stream_id == stream_id:
                return pair.viewer
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._view_waiters.setdefault(stream_id, []).append(fut)
        log.debug("requesting stream %r as %r", stream_id, hashed)
        self._send_ws({"request": "play", "streamID": hashed})
        try:
            return await asyncio.wait_for(fut, opts.timeout)
        except asyncio.TimeoutError:
            waiters = self._view_waiters.get(stream_id, [])
            if fut in waiters:
                waiters.remove(fut)
            if generation != self._generation or self._intentional:
                raise VDONinjaError("operation cancelled by disconnect")
            self._schedule_view_retry(stream_id, opts, self.view_retry_interval)
            raise StreamNotYetAvailable(stream_id)

    def _schedule_view_retry(self, stream_id: str, opts: _ViewOptions, delay: float) -> None:
        if self._intentional or stream_id in self._stopped_views:
            return
        old = self._view_retry_tasks.pop(stream_id, None)
        if old:
            old.cancel()
        generation = self._generation

        async def retry() -> None:
            await asyncio.sleep(delay)
            self._view_retry_tasks.pop(stream_id, None)
            if generation != self._generation or self._intentional or stream_id in self._stopped_views or not self._connected:
                return
            log.debug("retrying view for %r", stream_id)
            await self._view_quiet(stream_id, opts)

        self._view_retry_tasks[stream_id] = asyncio.ensure_future(retry())

    async def stop_viewing(self, stream_id: str) -> None:
        stream_id = sanitize_stream_id(stream_id)
        self._view_intent.pop(stream_id, None)
        self._stopped_views.add(stream_id)
        task = self._view_retry_tasks.pop(stream_id, None)
        if task:
            task.cancel()
        self._pending_views.pop(stream_id, None)
        closing = []
        for uuid, pair in list(self.connections.items()):
            if pair.viewer and pair.viewer.stream_id == stream_id:
                closing.append(pair.viewer)
                pair.viewer = None
                if pair.empty:
                    del self.connections[uuid]
        if stream_id in self.streams:
            self.streams[stream_id]["state"] = "available"
        await self._close_with_bye(closing)
        self._emit(Event("viewingStopped", stream_id=stream_id))

    def peers(self) -> List[str]:
        return list(self.connections.keys())

    def connection(self, uuid: str, kind: str) -> Optional[Connection]:
        pair = self.connections.get(uuid)
        return pair.get(kind) if pair else None

    def _find_connection(self, uuid: str, kind: Optional[str] = None) -> Optional[Connection]:
        pair = self.connections.get(uuid)
        if not pair:
            return None
        if kind in ("publisher", "viewer"):
            return pair.get(kind)
        return pair.publisher or pair.viewer

    # ------------------------------------------------------- signaling input

    async def _handle_signaling(self, msg: Dict[str, Any]) -> None:
        if "description" in msg:
            await self._handle_sdp(msg, None)
        elif "candidate" in msg:
            await self._handle_candidates(msg, None, True)
        elif "candidates" in msg:
            await self._handle_candidates(msg, None, False)
        elif msg.get("iceRestartRequest") and msg.get("UUID"):
            conn = self._find_connection(msg["UUID"], "publisher")
            if conn:
                await self._restart_ice(conn, "remote_request")
        elif "request" in msg:
            request = msg.get("request")
            if request == "joinroom":
                await self._handle_peer_join_room(msg)
            elif request == "play":
                await self._handle_play_request(msg)
            elif request == "listing":
                self._handle_listing(msg)
            elif request == "videoaddedtoroom":
                self._handle_video_added(msg)
            elif request == "someonejoined":
                clean = self._strip_hash(msg.get("streamID"))
                if clean:
                    self._emit(Event("videoaddedtoroom", stream_id=clean, uuid=msg.get("UUID"), raw=msg))
                self._emit(Event("someoneJoined", stream_id=clean, uuid=msg.get("UUID"), raw=msg))
            elif request == "error":
                self._emit(Event("error", message=msg.get("message"), raw=msg))
            elif request == "alert":
                text = str(msg.get("message", ""))
                if "Stream ID is already in use" in text:
                    self.publishing = False
                    self.stream_id = None
                self._emit(Event("alert", message=text, raw=msg))
            elif request == "transferred":
                self._emit(Event("transferred", raw=msg))
                self._handle_listing(msg)
            elif request == "offerSDP":
                await self._handle_offer_request(msg.get("UUID"), None)
        elif "rejected" in msg:
            self._emit(Event("alert", message="connection rejected", raw=msg))
        elif "approved" in msg:
            self._emit(Event("alert", message="connection approved", raw=msg))
        elif msg.get("bye"):
            await self._handle_bye(msg.get("UUID"), "bye", msg)
        elif msg.get("hangup"):
            await self._handle_bye(msg.get("UUID"), "hangup", msg)

    def _handle_listing(self, msg: Dict[str, Any]) -> None:
        waiters, self._room_waiters = self._room_waiters, []
        entries: List[Dict[str, Any]] = []
        now = time.time()
        items = msg.get("list")
        if isinstance(items, list):
            for item in items:
                entry: Dict[str, Any] = {}
                if isinstance(item, str):
                    entry["streamID"] = self._strip_hash(item)
                elif isinstance(item, dict):
                    entry["streamID"] = self._strip_hash(item.get("streamID"))
                    entry["UUID"] = item.get("UUID") or item.get("uuid")
                    if item.get("label"):
                        entry["label"] = item["label"]
                    if item.get("director"):
                        entry["director"] = True
                sid = entry.get("streamID")
                if sid:
                    info = self.streams.setdefault(sid, {"streamID": sid, "firstSeen": now, "uuid": None, "state": "available"})
                    info["lastSeen"] = now
                    if entry.get("UUID"):
                        info["uuid"] = entry["UUID"]
                    if info.get("state") in (None, "disconnected"):
                        info["state"] = "available"
                entries.append(entry)
        elif msg.get("streamID"):
            entries.append({"streamID": self._strip_hash(msg["streamID"]), "UUID": msg.get("UUID")})
        for fut in waiters:
            if not fut.done():
                fut.set_result(True)
        self._emit(Event("listing", list=entries, raw=msg))

    def _handle_video_added(self, msg: Dict[str, Any]) -> None:
        clean = self._strip_hash(msg.get("streamID"))
        uuid = msg.get("UUID")
        now = time.time()
        if clean:
            info = self.streams.setdefault(clean, {"streamID": clean, "firstSeen": now, "uuid": None, "state": "available"})
            info["lastSeen"] = now
            if uuid:
                info["uuid"] = uuid
        # The server can offer immediately, before our delayed play retry.
        # Retain the caller's preferences until that offer is processed.
        opts = self._pending_views.get(clean) if clean else None
        if opts is not None:
            log.debug("re-requesting pending stream %r", clean)

            self._schedule_view_retry(clean, opts, 0.1)
        self._emit(Event("videoaddedtoroom", stream_id=clean, uuid=uuid, raw=msg))

    async def _handle_peer_join_room(self, msg: Dict[str, Any]) -> None:
        uuid = msg.get("UUID")
        if not uuid or not self.publishing:
            return
        await self._handle_offer_request(uuid, msg.get("session") or uuid)

    async def _handle_play_request(self, msg: Dict[str, Any]) -> None:
        requested = self._strip_hash(msg.get("streamID"))
        if not self.publishing or self.stream_id != requested:
            log.debug("ignoring play request for %r", requested)
            return
        await self._handle_offer_request(msg.get("UUID"), None)

    async def _handle_offer_request(self, uuid: Optional[str], session: Optional[str]) -> None:
        if not uuid or not self.publishing:
            return
        conn = await self._create_connection(uuid, "publisher")
        conn.stream_id = self.stream_id
        conn.session = session or generate_session()
        try:
            offer = await self._create_offer(conn)
        except Exception as exc:  # noqa: BLE001
            log.debug("create offer for %s failed: %s", uuid, exc)
            self._emit(Event("error", error=exc, uuid=uuid, message="failed to create offer"))
            return
        self._send_description(conn, offer, include_stream_id=True)

    async def _handle_bye(self, uuid: Optional[str], kind: str, msg: Dict[str, Any]) -> None:
        if not uuid:
            return
        self._pending_ice.pop(f"local:{uuid}", None)
        self._pending_ice.pop(f"remote:{uuid}", None)
        pair = self.connections.pop(uuid, None)
        retry = None
        # Only bye (the peer went away) schedules a retry of the view; hangup is the
        # peer ending the session on purpose, as in the JS SDK.
        if kind == "bye" and pair and pair.viewer and pair.viewer.stream_id and not self._intentional and pair.viewer.stream_id not in self._stopped_views:
            retry = (pair.viewer.stream_id, pair.viewer.view_options)
            if pair.viewer.stream_id in self.streams:
                self.streams[pair.viewer.stream_id]["state"] = "disconnected"
        if pair:
            for conn in (pair.publisher, pair.viewer):
                if conn:
                    await conn.close()
        if retry:
            self._schedule_view_retry(retry[0], retry[1], 2.0)
        self._emit(Event(kind, uuid=uuid, raw=msg))
        self._emit(Event("peerDisconnected", uuid=uuid))

    # ------------------------------------------------------- peer connection

    async def _ice_servers(self) -> List[RTCIceServer]:
        servers = [RTCIceServer(urls=[u]) for u in self.stun_servers]
        if self.turn is False:
            return servers
        if isinstance(self.turn, list):
            return servers + self.turn
        if self._turn_list is None or time.time() - self._turn_fetched > self.turn_cache_ttl:
            loop = asyncio.get_running_loop()
            raw = await loop.run_in_executor(None, turn_module.fetch_turn_servers, self.turn_url)
            self._turn_list = turn_module.select_turn_servers(raw, force_tcp=self.force_tcp)
            self._turn_fetched = time.time()
        return servers + list(self._turn_list)

    async def _create_connection(self, uuid: str, kind: str) -> Connection:
        pc = RTCPeerConnection(RTCConfiguration(iceServers=await self._ice_servers()))
        conn = Connection(self, uuid, kind, pc)

        @pc.on("connectionstatechange")
        async def _on_state() -> None:
            await self._handle_peer_state(conn)

        @pc.on("iceconnectionstatechange")
        async def _on_ice_state() -> None:
            await self._handle_peer_state(conn)

        @pc.on("track")
        def _on_track(track: MediaStreamTrack) -> None:
            log.debug("track %s from %s", track.kind, uuid)
            self._emit(Event("track", uuid=uuid, stream_id=conn.stream_id, connection_type=kind, track=track))

        @pc.on("datachannel")
        def _on_datachannel(channel: RTCDataChannel) -> None:
            self._handle_incoming_channel(conn, channel)

        if kind == "publisher":
            dc = pc.createDataChannel(CONTROL_CHANNEL, ordered=True)
            conn.control = dc
            conn.channels[CONTROL_CHANNEL] = dc
            self._setup_control_channel(conn, dc)

        pair = self.connections.setdefault(uuid, _PeerPair())
        old = pair.get(kind)
        pair.set(kind, conn)
        if old:
            log.debug("replacing existing %s connection to %s", kind, uuid)
            await old.close()

        async def connect_timeout() -> None:
            await asyncio.sleep(self.connection_timeout)
            if self._is_current(conn) and pc.connectionState not in ("connected",) and pc.iceConnectionState not in ("connected", "completed"):
                await self._recover(conn, "connect-timeout")

        conn.connect_task = asyncio.ensure_future(connect_timeout())
        return conn

    def _is_current(self, conn: Connection) -> bool:
        pair = self.connections.get(conn.uuid)
        return bool(pair) and (pair.publisher is conn or pair.viewer is conn)

    async def _create_offer(self, conn: Connection) -> RTCSessionDescription:
        # Initial negotiation establishes the control channel only.
        offer = await conn.pc.createOffer()
        await conn.pc.setLocalDescription(offer)
        return conn.pc.localDescription

    def _send_description(self, conn: Connection, desc: RTCSessionDescription, include_stream_id: bool, via_signaling: bool = False) -> None:
        payload = {"type": desc.type, "sdp": desc.sdp}
        msg: Dict[str, Any] = {"UUID": conn.uuid, "session": conn.session}
        if include_stream_id and conn.stream_id:
            msg["streamID"] = self.hashed_stream_id(conn.stream_id)
        if self._effective_password() is not None:
            try:
                msg["description"], msg["vector"] = self._encrypt(payload)
            except Exception as exc:  # noqa: BLE001
                self._emit(Event("error", error=exc, uuid=conn.uuid, message="failed to encrypt description"))
                return
        else:
            msg["description"] = payload
        if not via_signaling and conn.control_open:
            dc_msg = {"description": msg["description"], "session": msg["session"]}
            if desc.type == "offer" and conn.stream_id:
                dc_msg["streamID"] = conn.stream_id
            if "vector" in msg:
                dc_msg["vector"] = msg["vector"]
            if conn.send_control(dc_msg):
                return
        self._send_ws(msg)

    def _decode_description(self, msg: Dict[str, Any]) -> Optional[RTCSessionDescription]:
        desc = msg.get("description")
        if isinstance(desc, str):
            iv = msg.get("vector")
            if not iv:
                return None
            try:
                desc = self._decrypt(desc, iv)
            except Exception as exc:  # noqa: BLE001
                log.debug("failed to decrypt description: %s", exc)
                return None
        if not isinstance(desc, dict) or not desc.get("sdp") or desc.get("type") not in ("offer", "answer"):
            return None
        return RTCSessionDescription(sdp=desc["sdp"], type=desc["type"])

    async def _handle_sdp(self, msg: Dict[str, Any], via: Optional[Connection]) -> None:
        desc = self._decode_description(msg)
        if desc is None:
            return
        uuid = via.uuid if via else msg.get("UUID")
        session = msg.get("session") or (via.session if via else None)
        if desc.type == "offer":
            await self._handle_offer(uuid, session, msg, desc, via)
        else:
            await self._handle_answer(uuid, session, desc)

    async def _handle_offer(self, uuid: str, session: Optional[str], msg: Dict[str, Any], desc: RTCSessionDescription, via: Optional[Connection]) -> None:
        has_stream = "streamID" in msg and isinstance(msg["streamID"], str)
        clean = self._strip_hash(msg["streamID"]) if has_stream else None
        pair = self.connections.get(uuid)
        conn = via if (via and via.type == "viewer") else (pair.viewer if pair else None)
        if conn and conn.session and session and conn.session != session:
            log.debug("session mismatch for %s; replacing viewer connection", uuid)
            if pair:
                pair.viewer = None
            await conn.close()
            conn = None
        if conn is None:
            opts = (self._pending_views.get(clean) or self._view_intent.get(clean)) if clean else None
            conn = await self._create_connection(uuid, "viewer")
            conn.session = session
            if has_stream:
                conn.stream_id = clean
            conn.view_options = opts or _ViewOptions()
            if clean and clean in self.streams:
                self.streams[clean]["uuid"] = uuid
        else:
            conn.session = conn.session or session
            if not conn.stream_id and has_stream:
                conn.stream_id = clean
        try:
            await conn.pc.setRemoteDescription(desc)
            await self._drain_pending_ice(conn, "local")
            answer = await conn.pc.createAnswer()
            await conn.pc.setLocalDescription(answer)
        except Exception as exc:  # noqa: BLE001
            log.debug("handling offer failed: %s", exc)
            self._emit(Event("error", error=exc, uuid=uuid, message="failed to handle offer"))
            return
        local = conn.pc.localDescription
        payload = {"type": local.type, "sdp": local.sdp}
        out: Dict[str, Any] = {"UUID": uuid, "session": session}
        if has_stream:
            out["streamID"] = msg["streamID"]
        if self._effective_password() is not None:
            out["description"], out["vector"] = self._encrypt(payload)
        else:
            out["description"] = payload
        if conn.control_open:
            dc_msg = {"description": out["description"]}
            if "vector" in out:
                dc_msg["vector"] = out["vector"]
            conn.send_control(dc_msg)
        else:
            self._send_ws(out)
        if clean:
            for fut in self._view_waiters.pop(clean, []):
                if not fut.done():
                    fut.set_result(conn)
            self._pending_views.pop(clean, None)

    async def _handle_answer(self, uuid: str, session: Optional[str], desc: RTCSessionDescription) -> None:
        conn = self._find_connection(uuid, "publisher") or self._find_connection(uuid)
        if conn is None:
            log.debug("no connection for answer from %s", uuid)
            return
        if session and conn.session and session != conn.session:
            log.debug("session mismatch; ignoring answer from %s", uuid)
            return
        try:
            await conn.pc.setRemoteDescription(desc)
            await self._drain_pending_ice(conn, "remote")
        except Exception as exc:  # noqa: BLE001
            self._emit(Event("error", error=exc, uuid=uuid, message="failed to handle answer"))

    async def _renegotiate(self, conn: Connection, via_signaling: bool = False) -> None:
        offer = await conn.pc.createOffer()
        await conn.pc.setLocalDescription(offer)
        self._send_description(conn, conn.pc.localDescription, include_stream_id=True, via_signaling=via_signaling)

    async def _restart_ice(self, conn: Connection, reason: str) -> None:
        if conn.type == "viewer":
            if conn.send_control({"iceRestartRequest": True}):
                self._emit(Event("iceRestart", uuid=conn.uuid, stream_id=conn.stream_id, reason=reason))
            return
        # aiortc has no ICE-restart offer option; a fresh offer at least re-syncs
        # the session. Viewers that keep failing re-request the stream instead.
        try:
            # A restart we initiate because the connection failed travels over signaling:
            # the data channel it would otherwise use is the thing that is broken.
            await self._renegotiate(conn, via_signaling=reason != "remote_request")
            self._emit(Event("iceRestart", uuid=conn.uuid, stream_id=conn.stream_id, reason=reason))
        except Exception as exc:  # noqa: BLE001
            log.debug("renegotiation failed for %s: %s", conn.uuid, exc)

    # ---------------------------------------------------------- ICE handling

    def _decode_candidates(self, msg: Dict[str, Any], single: bool) -> List[Dict[str, Any]]:
        key = "candidate" if single else "candidates"
        value = msg.get(key)
        if isinstance(value, str):
            iv = msg.get("vector")
            if not iv:
                return []
            try:
                value = self._decrypt(value, iv)
            except Exception as exc:  # noqa: BLE001
                log.debug("failed to decrypt candidates: %s", exc)
                return []
        if isinstance(value, dict):
            value = [value]
        if not isinstance(value, list):
            return []
        return [c for c in value if isinstance(c, dict) and c.get("candidate")]

    async def _handle_candidates(self, msg: Dict[str, Any], via: Optional[Connection], single: bool) -> None:
        cands = self._decode_candidates(msg, single)
        if not cands:
            return
        uuid = via.uuid if via else msg.get("UUID")
        msg_type = msg.get("type")
        if msg_type == "remote":
            conn = self._find_connection(uuid, "publisher")
        elif msg_type == "local":
            conn = self._find_connection(uuid, "viewer")
        else:
            conn = via or self._find_connection(uuid)
        session = msg.get("session")
        if conn is None or conn.pc.remoteDescription is None:
            self._queue_pending_ice(uuid, msg_type, session, cands)
            return
        if session and conn.session and session != conn.session:
            log.debug("session mismatch; ignoring candidates from %s", uuid)
            return
        for cand in cands:
            await self._add_candidate(conn, cand)

    async def _add_candidate(self, conn: Connection, cand: Dict[str, Any]) -> None:
        line = cand.get("candidate", "")
        if line.startswith("candidate:"):
            line = line[len("candidate:"):]
        if not line:
            return
        try:
            candidate = candidate_from_sdp(line)
            candidate.sdpMid = cand.get("sdpMid")
            idx = cand.get("sdpMLineIndex")
            candidate.sdpMLineIndex = int(idx) if idx is not None else None
            await conn.pc.addIceCandidate(candidate)
        except Exception as exc:  # noqa: BLE001
            log.debug("addIceCandidate failed: %s", exc)

    def _queue_pending_ice(self, uuid: Optional[str], msg_type: Optional[str], session: Optional[str], cands: List[Dict[str, Any]]) -> None:
        if not uuid or msg_type not in ("local", "remote"):
            return
        queue = self._pending_ice.setdefault(f"{msg_type}:{uuid}", [])
        now = time.time()
        queue.extend({"candidate": c, "session": session, "ts": now} for c in cands)
        del queue[:-100]
        log.debug("queued %d ICE candidate(s) for %s (%s)", len(cands), uuid, msg_type)

    async def _drain_pending_ice(self, conn: Connection, msg_type: str) -> None:
        queue = self._pending_ice.pop(f"{msg_type}:{conn.uuid}", [])
        for item in queue:
            if time.time() - item["ts"] > 15:
                continue
            if item["session"] and conn.session and item["session"] != conn.session:
                continue
            await self._add_candidate(conn, item["candidate"])

    # ------------------------------------------------------------ peer state

    async def _handle_peer_state(self, conn: Connection) -> None:
        if not self._is_current(conn):
            return
        peer, ice = conn.pc.connectionState, conn.pc.iceConnectionState
        if peer == "failed" or ice == "failed":
            state = "failed"
        elif peer == "disconnected" or ice == "disconnected":
            state = "disconnected"
        elif peer == "connected" or ice in ("connected", "completed"):
            state = "connected"
        elif peer == "closed":
            state = "closed"
        else:
            return
        log.debug("peer state for %s/%s: %s", conn.uuid, conn.type, state)
        if state == "connected":
            if conn.connect_task:
                conn.connect_task.cancel()
            if conn.disconnect_task:
                conn.disconnect_task.cancel()
                conn.disconnect_task = None
            first = not conn.connected_once
            conn.connected_once = True
            conn.recovering = False
            self._set_stream_state(conn.stream_id, "connected")
            if first:
                self._emit(Event("peerConnected", uuid=conn.uuid, stream_id=conn.stream_id, connection_type=conn.type))
        elif state == "disconnected":
            self._set_stream_state(conn.stream_id, "disconnected")
            if conn.disconnect_task is None:

                async def grace() -> None:
                    await asyncio.sleep(self.disconnect_grace_period)
                    conn.disconnect_task = None
                    if self._is_current(conn) and conn.pc.connectionState != "connected" and conn.pc.iceConnectionState not in ("connected", "completed"):
                        await self._recover(conn, "disconnected")

                conn.disconnect_task = asyncio.ensure_future(grace())
        elif state == "failed":
            self._set_stream_state(conn.stream_id, "failed")
            await self._recover(conn, "failed")
        elif state == "closed":
            # Closed by the remote side; our own close sets finalized first and its
            # caller reports the disconnect.
            if not conn.finalized and self._is_current(conn):
                await self._fail_connection(conn, "closed")

    def _set_stream_state(self, stream_id: Optional[str], state: str) -> None:
        if stream_id and stream_id in self.streams:
            self.streams[stream_id]["state"] = state

    async def _recover(self, conn: Connection, reason: str) -> None:
        if not self._is_current(conn):
            return
        if conn.recovering:
            # Second failure: bounded recovery is over, tear the connection down.
            await self._fail_connection(conn, reason)
            return
        conn.recovering = True
        log.debug("recovering %s connection to %s (%s)", conn.type, conn.uuid, reason)
        if conn.type == "publisher" or conn.control_open:
            await self._restart_ice(conn, reason)
            self._arm_recovery_timer(conn)
            return
        # Nothing to talk over: start again from the play request.
        await self._fail_connection(conn, reason)

    def _arm_recovery_timer(self, conn: Connection) -> None:
        """Bounds an ICE restart: a connection still down after connection_timeout is given up on."""
        if conn.connect_task:
            conn.connect_task.cancel()

        async def restart_timeout() -> None:
            await asyncio.sleep(self.connection_timeout)
            if self._is_current(conn) and conn.pc.connectionState != "connected" and conn.pc.iceConnectionState not in ("connected", "completed"):
                await self._recover(conn, "restart_timeout")

        conn.connect_task = asyncio.ensure_future(restart_timeout())

    async def _fail_connection(self, conn: Connection, reason: str) -> None:
        """Closes and forgets a connection that could not be recovered, like the JS SDK's
        _handleConnectionFailed: peerDisconnected, then connectionFailed, then (viewer side)
        a retry of the view."""
        sid, opts = conn.stream_id, conn.view_options
        pair = self.connections.get(conn.uuid)
        if pair:
            if pair.viewer is conn:
                pair.viewer = None
            if pair.publisher is conn:
                pair.publisher = None
            if pair.empty:
                del self.connections[conn.uuid]
        await conn.close()
        self._emit(Event("peerDisconnected", uuid=conn.uuid, stream_id=sid, connection_type=conn.type))
        self._emit(Event("connectionFailed", uuid=conn.uuid, stream_id=sid, connection_type=conn.type, reason=reason))
        if conn.type == "viewer" and sid and sid not in self._stopped_views:
            self._schedule_view_retry(sid, opts, 2.0)

    # ---------------------------------------------------------- data channels

    def _handle_incoming_channel(self, conn: Connection, dc: RTCDataChannel) -> None:
        label = dc.label or ""
        log.debug("data channel from %s: %r", conn.uuid, label)
        conn.channels[label] = dc

        @dc.on("close")
        def _closed() -> None:
            if conn.channels.get(label) is dc:
                conn.channels.pop(label, None)

        if not label or label == CONTROL_CHANNEL:
            conn.control = dc
            self._setup_control_channel(conn, dc)
        elif label == CHUNKED_CHANNEL:
            self._emit(Event("unsupportedChannel", uuid=conn.uuid, stream_id=conn.stream_id, label=label, channel=dc))
        elif label == RESOURCES_CHANNEL:
            self._setup_resource_channel(conn, dc)
        elif label.startswith(RESERVED_PREFIX):
            if label == BINARY_CHANNEL:
                @dc.on("message")
                def _binary(data: Any) -> None:
                    if isinstance(data, (bytes, bytearray)):
                        self._emit(Event("binaryReceived", uuid=conn.uuid, stream_id=conn.stream_id, bytes=bytes(data), label=label))
            else:
                self._emit(Event("channelOpen", uuid=conn.uuid, stream_id=conn.stream_id, label=label, channel=dc))
        else:
            self._setup_file_receive_channel(conn, dc, label)

    def _setup_control_channel(self, conn: Connection, dc: RTCDataChannel) -> None:
        def on_open() -> None:
            log.debug("control channel open for %s/%s", conn.uuid, conn.type)
            if conn.type == "viewer":
                o = conn.view_options
                prefs: Dict[str, Any] = {"audio": o.audio, "video": o.video, "downloads": o.downloads, "info": {}}
                if o.label:
                    prefs["info"] = {"label": o.label}
                if o.allowresources:
                    prefs["allowresources"] = True
                conn.send_control(prefs)
            elif conn.send_control({"info": dict(self.publisher_info)}):
                conn.info_sent = True
                self._spawn(self._update_tracks(conn))
            self._start_ping_monitor(conn)
            self._emit(Event("dataChannelOpen", uuid=conn.uuid, stream_id=conn.stream_id, connection_type=conn.type, channel=dc, label=dc.label))

        if dc.readyState == "open":
            on_open()
        else:
            dc.on("open", on_open)

        @dc.on("close")
        def _close() -> None:
            if conn.ping_task:
                conn.ping_task.cancel()
                conn.ping_task = None
            self._emit(Event("dataChannelClose", uuid=conn.uuid, stream_id=conn.stream_id, connection_type=conn.type, label=dc.label))

        @dc.on("message")
        def _message(data: Any) -> None:
            conn.last_message = time.time()
            if not isinstance(data, str):
                return  # VDO.Ninja renders binary control payloads as images; ignore them.
            try:
                msg = json.loads(data)
            except ValueError:
                return
            if isinstance(msg, dict):
                log.debug("<- DC(%s/%s) %s", conn.uuid, conn.type, data[:300])
                self._spawn(self._handle_control_message(conn, msg))

    async def _handle_control_message(self, conn: Connection, msg: Dict[str, Any]) -> None:
        if isinstance(msg.get("fileList"), list):
            files = [FileEntry(id=str(f.get("id")), name=str(f.get("name", "")), size=int(f.get("size", 0) or 0)) for f in msg["fileList"] if isinstance(f, dict) and f.get("id") is not None]
            self._emit(Event("fileList", uuid=conn.uuid, stream_id=conn.stream_id, files=files))
        if isinstance(msg.get("requestFile"), (str, int, float)):
            self._handle_file_request(conn, str(msg["requestFile"]))
        if "downloads" in msg:
            conn.allow_downloads = msg["downloads"] is True
            if conn.type == "publisher" and conn.allow_downloads:
                self._send_file_list(conn)
        if "allowresources" in msg:
            conn.allow_resources = msg["allowresources"] is True
        if isinstance(msg.get("obsState"), dict):
            conn.obs_state.update(msg["obsState"])
            self._emit(Event("obsState", uuid=conn.uuid, stream_id=conn.stream_id, data=dict(conn.obs_state), raw=msg["obsState"]))
        if isinstance(msg.get("info"), dict):
            conn.info.update(msg["info"])
            self._emit(Event("peerInfo", uuid=conn.uuid, stream_id=conn.stream_id, info=dict(conn.info)))

        if "description" in msg:
            await self._handle_sdp(msg, conn)
        elif "candidate" in msg:
            await self._handle_candidates(msg, conn, True)
        elif "candidates" in msg:
            await self._handle_candidates(msg, conn, False)
        elif isinstance(msg.get("audio"), bool) or isinstance(msg.get("video"), bool):
            if isinstance(msg.get("audio"), bool):
                conn.allow_audio = msg["audio"]
            if isinstance(msg.get("video"), bool):
                conn.allow_video = msg["video"]
            await self._update_tracks(conn)
        elif msg.get("ping"):
            conn.send_control({"pong": msg["ping"]})
        elif msg.get("pong"):
            try:
                sent = int(msg["pong"])
            except (TypeError, ValueError):
                return
            latency = int(time.time() * 1000) - sent
            if conn.pending_ping == sent:
                conn.pending_ping = None
                conn.missed_pings = 0
            self._emit(Event("peerLatency", uuid=conn.uuid, stream_id=conn.stream_id, latency=latency))
        elif msg.get("bye"):
            await self._handle_bye(conn.uuid, "bye", msg)
        elif "videoMuted" in msg:
            self._emit(Event("remoteVideoMuteState", uuid=conn.uuid, stream_id=conn.stream_id, connection_type=conn.type, muted=bool(msg["videoMuted"]), raw=msg))
            self._emit(Event("dataReceived", uuid=conn.uuid, stream_id=conn.stream_id, data=msg, raw=msg))
        elif "pipe" in msg:
            pipe = msg["pipe"]
            if isinstance(pipe, dict) and pipe.get("type") in ("subscribe", "unsubscribe", "channelMessage", "request", "response"):
                self._handle_data_message(pipe, conn.uuid)
            else:
                self._emit(Event("dataReceived", uuid=conn.uuid, stream_id=conn.stream_id, data=pipe, raw=msg))
        elif msg.get("iceRestartRequest"):
            if conn.type == "publisher":
                await self._restart_ice(conn, "remote_request")

    async def _update_tracks(self, conn: Connection) -> None:
        if conn.type != "publisher" or not conn.control_open or not conn.info_sent:
            return
        async with conn.media_lock:
            changed = False
            for track in self._local_tracks:
                allowed = conn.allow_audio if track.kind == "audio" else conn.allow_video
                sender = next((s for s in conn.senders if s.kind == track.kind), None)
                if sender is None:
                    if allowed:
                        conn.senders.append(conn.pc.addTrack(track))
                        changed = True
                else:
                    # aiortc replaceTrack is synchronous.
                    sender.replaceTrack(track if allowed else None)
            if changed:
                await self._renegotiate(conn)

    def _start_ping_monitor(self, conn: Connection) -> None:
        if not self.auto_ping_viewer or conn.type != "viewer":
            return
        if conn.ping_task:
            conn.ping_task.cancel()
        interval = self.auto_ping_interval

        async def monitor() -> None:
            while True:
                await asyncio.sleep(interval)
                if not conn.control_open:
                    continue
                if conn.pending_ping is not None:
                    elapsed = time.time() * 1000 - conn.pending_ping
                    timeout = max(interval * 1.5, interval + 5) * 1000
                    if elapsed < timeout:
                        continue
                    conn.missed_pings += 1
                    conn.pending_ping = None
                    if conn.missed_pings >= 2:
                        conn.missed_pings = 0
                        await self._restart_ice(conn, "missed_pings")
                        continue
                self.send_ping(conn.uuid)

        conn.ping_task = asyncio.ensure_future(monitor())

    def send_ping(self, uuid: Optional[str] = None) -> bool:
        """Send a ping; the peer replies with pong and a ``peerLatency`` event fires."""
        ts = int(time.time() * 1000)
        for pid, pair in self.connections.items():
            if uuid and pid != uuid:
                continue
            for conn in (pair.publisher, pair.viewer):
                if conn:
                    conn.pending_ping = ts
        return self._send_data_internal({"ping": ts}, uuid, None, "any")

    # ------------------------------------------------------------------ data

    def send_data(self, data: Any, target: Union[None, str, Dict[str, Any]] = None) -> bool:
        """Send application data (wrapped in VDO.Ninja's ``{"pipe": ...}`` envelope).

        ``target`` may be a peer UUID or a dict with ``uuid``, ``type``
        (``publisher``/``viewer``), ``streamID``, ``preference``
        (``any``/``publisher``/``viewer``/``all``).
        """
        msg = {"pipe": data}
        if target is None:
            return self._send_data_internal(msg, None, None, "any")
        if isinstance(target, str):
            return self._send_data_internal(msg, target, None, "any")
        t = dict(target)
        uuid = t.get("uuid") or t.get("UUID")
        pref = t.get("preference") or t.get("channel") or t.get("prefer") or "any"
        pref = {"pcs": "publisher", "rpcs": "viewer"}.get(pref, pref)
        kind = {"pcs": "publisher", "rpcs": "viewer"}.get(t.get("type"), t.get("type"))
        if kind not in ("publisher", "viewer"):
            kind = None
        stream_id = t.get("streamID") or t.get("stream_id")
        if stream_id and not uuid:
            sent = False
            for pid, pair in list(self.connections.items()):
                for conn in (pair.publisher, pair.viewer):
                    if conn and (kind is None or conn.type == kind) and conn.stream_id == stream_id:
                        if self._send_data_internal(msg, pid, kind, pref):
                            sent = True
                        break
            return sent
        return self._send_data_internal(msg, uuid, kind, pref)

    def _send_data_internal(self, msg: Any, uuid: Optional[str], kind: Optional[str], preference: str) -> bool:
        text = json.dumps(msg, separators=(",", ":"))
        sent = False

        def attempt(conn: Optional[Connection]) -> bool:
            if conn is None or (kind and conn.type != kind) or not conn.control_open:
                return False
            try:
                conn.control.send(text)  # type: ignore[union-attr]
                log.debug("-> DC(%s/%s) %s", conn.uuid, conn.type, text[:300])
                return True
            except Exception:  # noqa: BLE001
                return False

        targets = {uuid: self.connections[uuid]} if uuid and uuid in self.connections else ({} if uuid else dict(self.connections))
        for pair in targets.values():
            if preference == "publisher":
                sent |= attempt(pair.publisher)
            elif preference == "viewer":
                sent |= attempt(pair.viewer)
            elif preference == "all":
                sent |= attempt(pair.publisher)
                sent |= attempt(pair.viewer)
            else:
                sent |= attempt(pair.publisher) or attempt(pair.viewer)
        return sent

    def _send_raw_control(self, uuid: str, msg: Dict[str, Any]) -> bool:
        pair = self.connections.get(uuid)
        if not pair:
            return False
        for conn in (pair.publisher, pair.viewer):
            if conn and conn.send_control(msg):
                return True
        return False

    # ---------------------------------------------------------------- pubsub

    def subscribe(self, *channels: str) -> None:
        self._subscriptions.update(channels)
        if self._connected:
            self.send_data({"type": "subscribe", "channels": list(channels)})

    def unsubscribe(self, *channels: str) -> None:
        self._subscriptions.difference_update(channels)
        if self._connected:
            self.send_data({"type": "unsubscribe", "channels": list(channels)})

    def subscriptions(self) -> List[str]:
        return sorted(self._subscriptions)

    def peer_subscriptions(self, uuid: str) -> List[str]:
        return sorted(self._peer_subs.get(uuid, set()))

    def publish_to_channel(self, channel: str, data: Any, target: str = "all") -> bool:
        msg = {"type": "channelMessage", "channel": channel, "data": data, "timestamp": int(time.time() * 1000)}
        return self.send_data(msg) if target in ("all", "", None) else self.send_data(msg, target)

    # ------------------------------------------------------- request/response

    def on_request(self, request_type: str, handler: Optional[Callable[[Any, str], Any]]) -> None:
        """Register a handler ``(data, from_uuid) -> result`` (sync or async)."""
        if handler is None:
            self._request_handlers.pop(request_type, None)
        else:
            self._request_handlers[request_type] = handler

    async def request(self, request_type: str, data: Any, target_uuid: str, timeout: float = 5.0) -> Any:
        """Send a request to a peer and await the response."""
        request_id = str(uuid_module.uuid4())
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending_requests[request_id] = {"future": fut, "target": target_uuid}
        ok = self.send_data({"type": "request", "requestType": request_type, "requestId": request_id, "data": data}, target_uuid)
        if not ok:
            self._pending_requests.pop(request_id, None)
            raise VDONinjaError("no open data channel to peer")
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self._pending_requests.pop(request_id, None)
            raise VDONinjaError(f"request timeout: {request_type}")

    def respond(self, request_id: str, data: Any, target_uuid: str) -> bool:
        return self.send_data({"type": "response", "requestId": request_id, "data": data}, target_uuid)

    def _handle_data_message(self, data: Dict[str, Any], uuid: Optional[str]) -> None:
        kind = data.get("type")
        if kind in ("subscribe", "unsubscribe"):
            channels = data.get("channels")
            if isinstance(channels, str):
                channels = [channels]
            channels = [c for c in (channels or []) if isinstance(c, str)]
            subs = self._peer_subs.setdefault(uuid or "", set())
            if kind == "subscribe":
                subs.update(channels)
            else:
                subs.difference_update(channels)
            self._emit(Event("peerSubscribed" if kind == "subscribe" else "peerUnsubscribed", uuid=uuid, channels=channels, data=sorted(subs)))
        elif kind == "channelMessage":
            if data.get("channel") in self._subscriptions:
                self._emit(Event("channelMessage", uuid=uuid, channel_name=data.get("channel"), data=data.get("data"), timestamp=data.get("timestamp")))
        elif kind == "request":
            handler = self._request_handlers.get(data.get("requestType"))
            request_id = data.get("requestId")
            if not handler or not request_id or not uuid:
                return

            async def run() -> None:
                try:
                    result = handler(data.get("data"), uuid)
                    if inspect.isawaitable(result):
                        result = await result
                    self.respond(request_id, result, uuid)
                except Exception as exc:  # noqa: BLE001
                    self.respond(request_id, {"error": str(exc) or "Request handler error"}, uuid)

            self._spawn(run())
        elif kind == "response":
            pending = self._pending_requests.get(data.get("requestId"))
            if not pending or (pending["target"] and pending["target"] != uuid):
                return
            self._pending_requests.pop(data.get("requestId"), None)
            fut = pending["future"]
            if fut.done():
                return
            payload = data.get("data")
            if isinstance(payload, dict) and payload.get("error"):
                fut.set_exception(VDONinjaError(str(payload["error"])))
            else:
                fut.set_result(payload)
        else:
            self._emit(Event("dataReceived", uuid=uuid, data=data))

    # ----------------------------------------------------------- auto connect

    async def auto_connect(self, room: str, *, mode: str = "half", view: Optional[Dict[str, Any]] = None, label: str = "", password: Union[str, bool, None] = None, stream_id: Optional[str] = None, filter: Optional[Callable[[str, Optional[str]], bool]] = None) -> Dict[str, Any]:
        """Connect, join ``room``, announce and view peers as they appear.

        ``mode="half"`` gives one data channel per pair; ``"full"`` views every
        peer (needed for media). Returns ``{"streamID": ..., "stop": callable}``.
        """
        if not room:
            raise VDONinjaError("room is required")
        base = {"audio": mode == "full", "video": mode == "full"}
        base.update(view or {})
        viewed: set = set()
        state: Dict[str, Optional[str]] = {"me": None}

        def consider(sid: Optional[str], uuid: Optional[str]) -> None:
            me = state["me"]
            if not me or not sid or sid == me:
                return
            if filter and not filter(sid, uuid):
                return
            if mode == "half" and not (sid < me):
                return
            if sid in viewed:
                return
            viewed.add(sid)

            async def go() -> None:
                try:
                    await self.view(sid, **base)
                except StreamNotYetAvailable:
                    pass
                except Exception:  # noqa: BLE001
                    viewed.discard(sid)

            self._spawn(go())

        off_listing = self.on("listing", lambda ev: [consider(e.get("streamID"), e.get("UUID")) for e in (ev.list or [])])
        off_added = self.on("videoaddedtoroom", lambda ev: consider(ev.stream_id, ev.uuid))

        def stop() -> None:
            off_listing()
            off_added()

        try:
            if not self._connected:
                await self.connect()
            if not self.room_joined or self.room != sanitize_room(room):
                await self.join_room(room, password)
            sid = await self.announce(stream_id=stream_id, label=label)
        except Exception:
            stop()
            raise
        state["me"] = sid
        for info in list(self.streams.values()):
            consider(info.get("streamID"), info.get("uuid"))
        return {"streamID": sid, "stop": stop}

    # ----------------------------------------------------------------- files

    def host_file(self, name: str, data: bytes, *, file_id: Optional[str] = None, restricted: Optional[str] = None) -> FileEntry:
        """Offer bytes with VDO.Ninja's native file transfer (shows as a download in VDO.Ninja chat)."""
        if not name:
            raise VDONinjaError("file name required")
        if file_id and file_id.startswith(RESERVED_PREFIX):
            raise VDONinjaError("file id uses the reserved x- prefix")
        fid = file_id or ""
        while not fid or fid in (CONTROL_CHANNEL, CHUNKED_CHANNEL, RESOURCES_CHANNEL) or fid.startswith(RESERVED_PREFIX) or fid in self._hosted_files:
            fid = generate_stream_id()
        self._hosted_files[fid] = {"id": fid, "name": name, "size": len(data), "data": bytes(data), "restricted": restricted, "cancelled": False}
        entry = FileEntry(id=fid, name=name, size=len(data))
        for uuid, pair in self.connections.items():
            if pair.publisher and (not restricted or restricted == uuid):
                self._send_file_entries(pair.publisher, [entry])
        return entry

    def unhost_file(self, file_id: str) -> bool:
        f = self._hosted_files.pop(file_id, None)
        if not f:
            return False
        f["cancelled"] = True
        return True

    def hosted_files(self) -> List[FileEntry]:
        return [FileEntry(id=f["id"], name=f["name"], size=f["size"]) for f in self._hosted_files.values()]

    def _file_list_for(self, uuid: str) -> List[FileEntry]:
        return [FileEntry(id=f["id"], name=f["name"], size=f["size"]) for f in self._hosted_files.values() if not f["restricted"] or f["restricted"] == uuid]

    def _send_file_list(self, conn: Connection) -> None:
        self._send_file_entries(conn, self._file_list_for(conn.uuid))

    def _send_file_entries(self, conn: Connection, entries: List[FileEntry]) -> None:
        unsent = [e for e in entries if e.id not in conn.advertised]
        if not conn.allow_downloads or not unsent:
            return
        if conn.send_control({"fileList": [{"id": e.id, "name": e.name, "size": e.size} for e in unsent]}):
            conn.advertised.update(e.id for e in unsent)

    def _handle_file_request(self, conn: Connection, file_id: str) -> None:
        f = self._hosted_files.get(file_id)
        if not f or (f["restricted"] and f["restricted"] != conn.uuid):
            log.debug("refusing file request %r from %s", file_id, conn.uuid)
            return
        dc = conn.pc.createDataChannel(file_id)
        conn.channels[file_id] = dc
        dc.on("open", lambda: self._spawn(self._send_file(conn, dc, f)))

    async def _send_file(self, conn: Connection, dc: RTCDataChannel, f: Dict[str, Any]) -> None:
        info = {"id": f["id"], "name": f["name"], "size": f["size"], "bytes": 0, "direction": "outbound", "requested": True}
        try:
            dc.send(json.dumps({"type": "filetransfer", "size": f["size"], "filename": f["name"], "id": f["id"]}))
            self._emit(Event("fileTransferStart", uuid=conn.uuid, stream_id=conn.stream_id, file=dict(info)))
            data = f["data"]
            for offset in range(0, len(data), FILE_CHUNK_SIZE):
                if f["cancelled"]:
                    dc.send(FILE_EOF_CANCELLED)
                    self._emit(Event("fileTransferCancelled", uuid=conn.uuid, stream_id=conn.stream_id, file=dict(info)))
                    await _wait_drain(dc)
                    dc.close()
                    return
                await _wait_below(dc, BUFFER_HIGH)
                dc.send(data[offset: offset + FILE_CHUNK_SIZE])
                info["bytes"] = min(len(data), offset + FILE_CHUNK_SIZE)
                self._emit(Event("fileTransferProgress", uuid=conn.uuid, stream_id=conn.stream_id, file=dict(info)))
            await _wait_drain(dc)
            dc.send(FILE_EOF_COMPLETE)
            await _wait_drain(dc)
            self._emit(Event("fileTransferComplete", uuid=conn.uuid, stream_id=conn.stream_id, file=dict(info)))
            await asyncio.sleep(1.0)
            if dc.readyState == "open":
                dc.close()
        except Exception as exc:  # noqa: BLE001
            self._emit(Event("fileTransferError", uuid=conn.uuid, stream_id=conn.stream_id, error=exc, file=dict(info)))
            dc.close()

    async def request_file(self, uuid: str, file_id: str, *, stream: bool = False, timeout: float = 30.0) -> FileResult:
        """Download a file a peer advertised (``fileList`` event).

        With ``stream=True`` the data arrives as ``fileChunk`` events and
        ``FileResult.data`` is ``None``. ``timeout`` bounds the wait for the
        transfer to start.
        """
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        transfer = {"uuid": uuid, "id": file_id, "stream": stream, "chunks": [], "received": 0, "started": False, "future": fut, "name": "", "size": 0}
        key = f"{uuid}:{file_id}"
        self._inbound[key] = transfer
        if not self._send_raw_control(uuid, {"requestFile": file_id}):
            self._inbound.pop(key, None)
            raise VDONinjaError("no open data channel to peer")

        async def start_timeout() -> None:
            await asyncio.sleep(timeout)
            if not transfer["started"] and not fut.done():
                self._inbound.pop(key, None)
                fut.set_exception(VDONinjaError(f"file transfer {file_id} did not start"))

        timer = asyncio.ensure_future(start_timeout())
        try:
            return await fut
        finally:
            timer.cancel()

    def _setup_file_receive_channel(self, conn: Connection, dc: RTCDataChannel, label: str) -> None:
        state: Dict[str, Any] = {"details": None, "transfer": None, "id": label, "name": "", "size": 0}

        def fail(err: Exception) -> None:
            self._emit(Event("fileTransferError", uuid=conn.uuid, stream_id=conn.stream_id, error=err, file={"id": state["id"], "name": state["name"], "size": state["size"], "direction": "inbound"}))
            t = state["transfer"]
            if t:
                self._inbound.pop(f"{conn.uuid}:{t['id']}", None)
                if not t["future"].done():
                    t["future"].set_exception(err)
                state["transfer"] = None

        @dc.on("message")
        def _message(data: Any) -> None:
            if state["details"] is None:
                if not isinstance(data, str):
                    return
                try:
                    parsed = json.loads(data)
                except ValueError:
                    return
                if not isinstance(parsed, dict) or parsed.get("type") != "filetransfer":
                    return
                state["details"] = parsed
                state["id"] = str(parsed.get("id") or label)
                state["name"] = str(parsed.get("filename", ""))
                state["size"] = int(parsed.get("size", 0) or 0)
                t = self._inbound.get(f"{conn.uuid}:{state['id']}") or self._inbound.get(f"{conn.uuid}:{label}")
                if t:
                    t["started"] = True
                    t["name"], t["size"] = state["name"], state["size"]
                state["transfer"] = t
                self._emit(Event("fileTransferStart", uuid=conn.uuid, stream_id=conn.stream_id, file={"id": state["id"], "name": state["name"], "size": state["size"], "direction": "inbound", "requested": t is not None}))
                return
            t = state["transfer"]
            if isinstance(data, str):
                if data == FILE_EOF_COMPLETE:
                    received = t["received"] if t else 0
                    if t and received != state["size"]:
                        fail(VDONinjaError(f"size mismatch: received {received} of {state['size']} bytes"))
                    else:
                        self._emit(Event("fileTransferComplete", uuid=conn.uuid, stream_id=conn.stream_id, file={"id": state["id"], "name": state["name"], "size": state["size"], "bytes": received, "direction": "inbound"}))
                        if t:
                            self._inbound.pop(f"{conn.uuid}:{t['id']}", None)
                            if not t["future"].done():
                                t["future"].set_result(FileResult(id=state["id"], name=state["name"], size=state["size"], uuid=conn.uuid, stream_id=conn.stream_id, data=None if t["stream"] else b"".join(t["chunks"])))
                    dc.close()
                elif data == FILE_EOF_CANCELLED:
                    self._emit(Event("fileTransferCancelled", uuid=conn.uuid, stream_id=conn.stream_id, file={"id": state["id"], "name": state["name"], "size": state["size"], "direction": "inbound"}))
                    fail(VDONinjaError("transfer cancelled by remote peer"))
                    dc.close()
                return
            chunk = bytes(data)
            if t:
                t["received"] += len(chunk)
                if not t["stream"]:
                    t["chunks"].append(chunk)
                received = t["received"]
            else:
                received = len(chunk)
            file_info = {"id": state["id"], "name": state["name"], "size": state["size"], "bytes": received, "direction": "inbound"}
            self._emit(Event("fileTransferProgress", uuid=conn.uuid, stream_id=conn.stream_id, file=file_info))
            if t and t["stream"]:
                self._emit(Event("fileChunk", uuid=conn.uuid, stream_id=conn.stream_id, file=file_info, bytes=chunk))

        @dc.on("close")
        def _close() -> None:
            t = state["transfer"]
            if t and not t["future"].done():
                fail(VDONinjaError("file channel closed before completion"))

    # ------------------------------------------------------------- resources

    async def send_resource(self, uuid: str, template_name: str, data: bytes, mime_type: str = "image/png") -> None:
        """Send bytes on VDO.Ninja's ``resources`` channel to a peer that advertised ``allowresources``."""
        conn = self._find_connection(uuid, "publisher") or self._find_connection(uuid)
        if conn is None:
            raise VDONinjaError("peer not found")
        if not conn.allow_resources:
            raise VDONinjaError("peer did not advertise allowresources")
        dc = conn.channels.get(RESOURCES_CHANNEL)
        if dc is None:
            dc = conn.pc.createDataChannel(RESOURCES_CHANNEL, ordered=True, maxRetransmits=30)
            conn.channels[RESOURCES_CHANNEL] = dc
            await _wait_open(dc)
        dc.send(json.dumps({"templateName": template_name, "type": mime_type, "size": len(data)}))
        for offset in range(0, len(data), FILE_CHUNK_SIZE):
            await _wait_below(dc, BUFFER_HIGH)
            dc.send(data[offset: offset + FILE_CHUNK_SIZE])

    def _setup_resource_channel(self, conn: Connection, dc: RTCDataChannel) -> None:
        if not conn.view_options.allowresources:
            log.debug("peer %s opened an unsolicited resources channel; closing", conn.uuid)
            dc.close()
            return
        state: Dict[str, Any] = {"meta": None, "buf": bytearray()}

        @dc.on("message")
        def _message(data: Any) -> None:
            if isinstance(data, str):
                try:
                    parsed = json.loads(data)
                except ValueError:
                    return
                if isinstance(parsed, dict) and parsed.get("templateName"):
                    state["meta"] = parsed
                    state["buf"] = bytearray()
                return
            if state["meta"] is None:
                return
            state["buf"].extend(data)
            if len(state["buf"]) >= int(state["meta"].get("size", 0) or 0):
                self._emit(Event("resourceReceived", uuid=conn.uuid, stream_id=conn.stream_id, data=state["meta"], bytes=bytes(state["buf"])))
                state["meta"] = None
                state["buf"] = bytearray()

    # ---------------------------------------------------- extra channels/binary

    async def open_channel(self, uuid: str, label: str, *, ordered: bool = True, max_retransmits: Optional[int] = None, max_packet_life_time: Optional[int] = None, protocol: str = "", timeout: float = 15.0) -> RTCDataChannel:
        """Open an additional data channel in the reserved ``x-`` namespace (ignored by VDO.Ninja)."""
        if not label:
            raise VDONinjaError("channel label required")
        if not label.startswith(RESERVED_PREFIX):
            label = RESERVED_PREFIX + label
        if max_retransmits is not None and max_packet_life_time is not None:
            raise VDONinjaError("max_retransmits and max_packet_life_time are mutually exclusive")
        conn = self._find_connection(uuid, "publisher")
        if conn is None or conn.pc.connectionState == "closed":
            conn = self._find_connection(uuid, "viewer")
        if conn is None:
            raise VDONinjaError("peer not found")
        existing = conn.channels.get(label)
        if existing is not None and existing.readyState in ("connecting", "open"):
            await _wait_open(existing, timeout)
            return existing
        dc = conn.pc.createDataChannel(label, ordered=ordered, maxRetransmits=max_retransmits, maxPacketLifeTime=max_packet_life_time, protocol=protocol)
        conn.channels[label] = dc

        @dc.on("close")
        def _close() -> None:
            if conn.channels.get(label) is dc:
                conn.channels.pop(label, None)

        await _wait_open(dc, timeout)
        return dc

    async def send_binary(self, uuid: str, data: bytes) -> None:
        """Send raw bytes on the dedicated ``x-bin`` lane (never the control channel)."""
        dc = await self.open_channel(uuid, BINARY_CHANNEL)
        await _wait_below(dc, BUFFER_HIGH)
        dc.send(bytes(data))

    # ----------------------------------------------------------------- stats

    async def stats(self, uuid: str) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        pair = self.connections.get(uuid)
        if pair:
            for kind in ("publisher", "viewer"):
                conn = pair.get(kind)
                if conn:
                    out[kind] = await conn.pc.getStats()
        return out

    async def peer_quality(self, uuid: str) -> Optional[PeerQuality]:
        reports = await self.stats(uuid)
        if not reports:
            return None
        q = PeerQuality()
        for report in reports.values():
            for stat in report.values():
                st = getattr(stat, "type", "")
                if st == "inbound-rtp":
                    q.packets_received += getattr(stat, "packetsReceived", 0) or 0
                    q.packets_lost += getattr(stat, "packetsLost", 0) or 0
                elif st == "transport":
                    q.bytes_sent += getattr(stat, "bytesSent", 0) or 0
                    q.bytes_received += getattr(stat, "bytesReceived", 0) or 0
                elif st == "remote-inbound-rtp":
                    rtt = getattr(stat, "roundTripTime", None)
                    if rtt:
                        q.rtt_ms = float(rtt) * 1000
        return q


async def _wait_open(dc: RTCDataChannel, timeout: float = 15.0) -> None:
    if dc.readyState == "open":
        return
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    dc.on("open", lambda: not fut.done() and fut.set_result(True))
    if dc.readyState == "open":
        return
    try:
        await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        raise VDONinjaError("data channel open timeout")


async def _wait_below(dc: RTCDataChannel, threshold: int, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while dc.bufferedAmount >= threshold:
        if dc.readyState != "open" or time.time() > deadline:
            raise VDONinjaError("data channel did not drain")
        await asyncio.sleep(0.005)


async def _wait_drain(dc: RTCDataChannel, timeout: float = 30.0) -> None:
    await _wait_below(dc, 1, timeout)

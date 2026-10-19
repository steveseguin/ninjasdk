# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MIT
"""WHIP (publish) and WHEP (view) clients for WebRTC-HTTP endpoints such as
Cloudflare Stream, Twitch, Meshcast and MediaMTX, built on aiortc."""

from __future__ import annotations

import asyncio
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Dict, List, Optional

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamTrack

_LINK_RE = re.compile(r"<([^>]+)>\s*;([^,]*)")
DEFAULT_ICE = [RTCIceServer(urls=["stun:stun.l.google.com:19302"]), RTCIceServer(urls=["stun:stun.cloudflare.com:3478"])]


def parse_ice_servers_from_link(header: str) -> List[RTCIceServer]:
    """Parse ``Link: <stun:host>; rel="ice-server"; username=".."; credential=".."`` headers."""
    out: List[RTCIceServer] = []
    for url, params in _LINK_RE.findall(header or ""):
        if "ice-server" not in params:
            continue
        username = credential = None
        for part in params.split(";"):
            key, _, value = part.strip().partition("=")
            value = value.strip('"')
            if key == "username":
                username = value
            elif key == "credential":
                credential = value
        out.append(RTCIceServer(urls=[url], username=username, credential=credential))
    return out


def _post_sdp(endpoint: str, sdp: str, token: Optional[str], headers: Dict[str, str]):
    req = urllib.request.Request(endpoint, data=sdp.encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/sdp")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            location = resp.headers.get("Location")
            link = resp.headers.get("Link", "")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"endpoint returned {exc.code}: {exc.read()[:200]!r}") from exc
    resource = urllib.parse.urljoin(endpoint, location) if location else None
    return body, resource, parse_ice_servers_from_link(link)


def _delete(resource: str, token: Optional[str], headers: Dict[str, str]) -> None:
    req = urllib.request.Request(resource, method="DELETE")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception:  # noqa: BLE001
        pass


class _Base:
    def __init__(self, endpoint: str, token: Optional[str], headers: Optional[Dict[str, str]], ice_servers: Optional[List[RTCIceServer]]):
        if not endpoint:
            raise ValueError("endpoint URL is required")
        self.endpoint = endpoint
        self.token = token
        self.headers = headers or {}
        self.ice_servers = ice_servers if ice_servers is not None else DEFAULT_ICE
        self.pc: Optional[RTCPeerConnection] = None
        self.resource: Optional[str] = None

    async def _negotiate(self, pc: RTCPeerConnection) -> None:
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)  # aiortc gathers all candidates here
        loop = asyncio.get_running_loop()
        answer, resource, _ = await loop.run_in_executor(None, _post_sdp, self.endpoint, pc.localDescription.sdp, self.token, self.headers)
        self.resource = resource
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))

    async def stop(self) -> None:
        """DELETE the resource and close the peer connection."""
        if self.resource:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _delete, self.resource, self.token, self.headers)
            self.resource = None
        if self.pc:
            await self.pc.close()
            self.pc = None


class WHIPClient(_Base):
    """Publish aiortc tracks to a WHIP endpoint."""

    def __init__(self, endpoint: str, *, token: Optional[str] = None, headers: Optional[Dict[str, str]] = None, ice_servers: Optional[List[RTCIceServer]] = None):
        super().__init__(endpoint, token, headers, ice_servers)

    async def publish(self, tracks: List[MediaStreamTrack]) -> None:
        if not tracks:
            raise ValueError("at least one track is required")
        pc = RTCPeerConnection(RTCConfiguration(iceServers=self.ice_servers))
        self.pc = pc
        for track in tracks:
            pc.addTrack(track)
        await self._negotiate(pc)


class WHEPClient(_Base):
    """Consume media from a WHEP endpoint; register ``on_track`` before ``view()``."""

    def __init__(self, endpoint: str, *, token: Optional[str] = None, headers: Optional[Dict[str, str]] = None, ice_servers: Optional[List[RTCIceServer]] = None, audio: bool = True, video: bool = True):
        super().__init__(endpoint, token, headers, ice_servers)
        self.audio = audio
        self.video = video
        self._on_track: Optional[Callable[[MediaStreamTrack], None]] = None

    def on_track(self, callback: Callable[[MediaStreamTrack], None]) -> None:
        self._on_track = callback

    async def view(self) -> None:
        pc = RTCPeerConnection(RTCConfiguration(iceServers=self.ice_servers))
        self.pc = pc
        if self._on_track:
            pc.on("track", self._on_track)
        if self.audio:
            pc.addTransceiver("audio", direction="recvonly")
        if self.video:
            pc.addTransceiver("video", direction="recvonly")
        await self._negotiate(pc)

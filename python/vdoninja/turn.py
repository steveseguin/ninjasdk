# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MPL-2.0
"""TURN discovery matching the JavaScript SDK (hosted list, timezone proximity, 2 UDP + 1 TCP)."""

from __future__ import annotations

import json
import time
import urllib.request
from typing import Any, Dict, List, Optional

from aiortc import RTCIceServer

DEFAULT_TURN_URL = "https://turnservers.vdo.ninja/"

FALLBACK_TURN_SERVERS: List[Dict[str, Any]] = [
    {"username": "steve", "credential": "setupYourOwnPlease", "urls": ["turns:www.turn.obs.ninja:443"], "tz": 300, "udp": False, "locale": "cae1"},
    {"username": "steve", "credential": "setupYourOwnPlease", "urls": ["turn:turn-cae1.vdo.ninja:3478"], "tz": 300, "udp": True, "locale": "cae1"},
    {"username": "vdoninja", "credential": "theyBeSharksHere", "urls": ["turn:turn-usw2.vdo.ninja:3478"], "tz": 480, "udp": True, "locale": "usw2"},
    {"username": "vdoninja", "credential": "PolandPirat", "urls": ["turn:turn-eu4.vdo.ninja:3478"], "tz": -70, "udp": True, "locale": "pol1"},
    {"username": "steve", "credential": "setupYourOwnPlease", "urls": ["turns:turn.obs.ninja:443"], "tz": -60, "udp": False, "locale": "de1"},
    {"username": "steve", "credential": "setupYourOwnPlease", "urls": ["turn:turn-eu1.vdo.ninja:3478"], "tz": -60, "udp": True, "locale": "de1"},
    {"username": "vdoninja", "credential": "EastSideRepresentZ", "urls": ["turn:turn-use1.vdo.ninja:3478"], "tz": 300, "udp": True, "locale": "use1"},
]


def fetch_turn_servers(url: str = DEFAULT_TURN_URL, timeout: float = 2.0) -> List[Dict[str, Any]]:
    """Download the hosted TURN list (blocking); falls back to the built-in list."""
    try:
        req = urllib.request.Request(f"{url}?ts={int(time.time() * 1000)}", headers={"User-Agent": "vdoninja-python"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        servers = data.get("servers")
        if isinstance(servers, list) and servers:
            return servers
    except Exception:  # noqa: BLE001 - any failure uses the fallback list
        pass
    return list(FALLBACK_TURN_SERVERS)


def local_timezone_offset_minutes() -> int:
    """Local UTC offset in minutes (JavaScript's -getTimezoneOffset())."""
    if time.daylight and time.localtime().tm_isdst > 0:
        return -time.altzone // 60
    return -time.timezone // 60


def select_turn_servers(servers: List[Dict[str, Any]], tz_offset_minutes: Optional[int] = None, force_tcp: bool = False) -> List[RTCIceServer]:
    """Pick the closest servers by timezone: up to two UDP and one TCP/TLS."""
    if tz_offset_minutes is None:
        tz_offset_minutes = local_timezone_offset_minutes()
    scored = []
    for s in servers:
        delta = abs(int(s.get("tz", 0)) - tz_offset_minutes)
        wrapped = abs(delta - 60 * 24)
        if wrapped < delta:
            delta = wrapped
        scored.append((delta, s))
    scored.sort(key=lambda item: item[0])
    out: List[RTCIceServer] = []
    udp = tcp = 0
    for _, s in scored:
        is_udp = bool(s.get("udp"))
        if force_tcp and is_udp:
            continue
        if is_udp and udp < 2:
            udp += 1
        elif not is_udp and tcp < 1:
            tcp += 1
        else:
            continue
        urls = s.get("urls", [])
        if isinstance(urls, str):
            urls = [urls]  # the standard scalar form; list("turn:...") would split characters
        out.append(RTCIceServer(urls=list(urls), username=s.get("username"), credential=s.get("credential")))
    return out

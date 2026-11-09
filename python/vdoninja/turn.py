# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MPL-2.0
"""TURN discovery matching the JavaScript SDK (hosted list, timezone proximity, 2 UDP + 1 TCP)."""

from __future__ import annotations

import json
import time
import urllib.request
from datetime import datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from typing import Any, Dict, List, Optional

from aiortc import RTCIceServer

DEFAULT_TURN_URL = "https://turnservers.vdo.ninja/"

FALLBACK_TURN_SERVERS: List[Dict[str, Any]] = [
    {"username":"use5","credential":"c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc","urls":["turn:turn-use5.vdo.ninja:3478"],"tz":300,"udp":True,"locale":"use5"},
    {"username":"use5","credential":"c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc","urls":["turns:turn-use5.vdo.ninja:443"],"tz":300,"udp":False,"locale":"use5"},
    {"username":"de3","credential":"NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc","urls":["turn:turn-de3.vdo.ninja:3478"],"tz":-60,"udp":True,"locale":"de3"},
    {"username":"de3","credential":"NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc","urls":["turns:turn-de3.vdo.ninja:443"],"tz":-60,"udp":False,"locale":"de3"},
    {"username":"pl2","credential":"vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=","urls":["turn:turn-pl2.vdo.ninja:3478"],"tz":-60,"udp":True,"locale":"pl2"},
    {"username":"pl2","credential":"vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=","urls":["turns:turn-pl2.vdo.ninja:443"],"tz":-60,"udp":False,"locale":"pl2"},
    {"username":"vdoninja","credential":"EastSideRepresentZ","urls":["turn:turn-use3.vdo.ninja:3478"],"tz":300,"udp":True,"locale":"use3"},
    {"username":"vdoninja","credential":"EastSideRepresentZ","urls":["turns:turn-use3.vdo.ninja:443"],"tz":300,"udp":False,"locale":"use3"},
    {"username":"vdoninja","credential":"ViennaSchnitzel","urls":["turn:turn-eu5.vdo.ninja:3478"],"tz":-60,"udp":True,"locale":"eu5"},
    {"username":"vdoninja","credential":"ViennaSchnitzel","urls":["turns:turn-eu5.vdo.ninja:443"],"tz":-60,"udp":False,"locale":"eu5"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turn:turn-usw3.vdo.ninja:3478"],"tz":480,"udp":True,"locale":"usw3"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turns:turn-usw3.vdo.ninja:443"],"tz":480,"udp":False,"locale":"usw3"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turn:turn-usw4.vdo.ninja:3478"],"tz":480,"udp":True,"locale":"usw4"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turns:turn-usw4.vdo.ninja:443"],"tz":480,"udp":False,"locale":"usw4"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turn:turn-usw5.vdo.ninja:3478"],"tz":480,"udp":True,"locale":"usw5"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turns:turn-usw5.vdo.ninja:443"],"tz":480,"udp":False,"locale":"usw5"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turn:turn-fr1.vdo.ninja:3478"],"tz":-60,"udp":True,"locale":"fr1"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turns:turn-fr1.vdo.ninja:443"],"tz":-60,"udp":False,"locale":"fr1"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turn:turn-fr2.vdo.ninja:3478"],"tz":-60,"udp":True,"locale":"fr2"},
    {"username":"vdoninja","credential":"donotuseplease","urls":["turns:turn-fr2.vdo.ninja:443"],"tz":-60,"udp":False,"locale":"fr2"},
    {"username":"vdoninja","credential":"IchBinSteveDerNinja","urls":["turn:www.turn.vdo.ninja:3478"],"tz":-60,"udp":True,"locale":"de2"},
    {"username":"vdoninja","credential":"IchBinSteveDerNinja","urls":["turns:www.turn.vdo.ninja:443"],"tz":-60,"udp":False,"locale":"de2"},
    {"username":"vdoninja","credential":"EastSideRepresentZ","urls":["turn:turn-use1.vdo.ninja:3478"],"tz":300,"udp":True,"locale":"use1"},
    {"username":"vdoninja","credential":"EastSideRepresentZ","urls":["turns:turn-use1.vdo.ninja:443"],"tz":300,"udp":False,"locale":"use1"},
    {"username":"vdoninja","credential":"pleaseUseYourOwn","urls":["turn:turn-use2.vdo.ninja:3478"],"tz":300,"udp":True,"locale":"use2"},
    {"username":"vdoninja","credential":"pleaseUseYourOwn","urls":["turns:turn-use2.vdo.ninja:443"],"tz":300,"udp":False,"locale":"use2"}
]


def fetch_turn_servers(url: str = DEFAULT_TURN_URL, timeout: float = 2.0) -> List[Dict[str, Any]]:
    """Download the hosted TURN list (blocking); falls back to the built-in list."""
    try:
        parts = urlsplit(url)
        query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key != "ts"]
        query.append(("ts", str(int(time.time() * 1000))))
        request_url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))
        req = urllib.request.Request(request_url, headers={"User-Agent": "vdoninja-python"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        servers = data.get("servers")
        if isinstance(servers, list) and servers:
            return servers
    except Exception:  # noqa: BLE001 - any failure uses the fallback list
        pass
    return list(FALLBACK_TURN_SERVERS)


def local_timezone_offset_minutes() -> int:
    """Browser lib.js getTimezone(): minutes west of UTC, with its DST adjustment."""
    current = int(-datetime.now().astimezone().utcoffset().total_seconds() / 60)
    try:
        # JavaScript new Date(0, 1) / new Date(6, 1) mean February 1900 / 1906.
        standard = max(int(-datetime(year, 2, 1).astimezone().utcoffset().total_seconds() / 60)
                       for year in (1900, 1906))
    except (OSError, OverflowError, ValueError):
        # Windows CRT cannot resolve pre-1970 local dates. Use its standard offset.
        standard = int(time.timezone / 60)
    return current + 60 if current < standard else current


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

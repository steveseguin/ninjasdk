# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MPL-2.0
"""A small VDO.Ninja-compatible signaling server (the routed ``wss2`` protocol).

Used by the test suite and handy for LAN/offline development::

    python -m vdoninja.signalserver --port 8080

It does not provide TURN or rate limiting; for production self-hosting see
https://github.com/steveseguin/websocket_server.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import uuid as uuid_module
from typing import Any, Dict, List, Optional, Set

import websockets

log = logging.getLogger("vdoninja.signalserver")


class SignalServer:
    def __init__(self) -> None:
        self.clients: Dict[str, Any] = {}
        self.streams: Dict[str, str] = {}
        self.stream_ids: Dict[str, str] = {}
        self.rooms: Dict[str, str] = {}
        self.room_list: Dict[str, List[str]] = {}
        self.directors: Dict[str, str] = {}
        self.waiting: Dict[str, Set[str]] = {}

    async def _send(self, uuid: str, payload: Dict[str, Any]) -> None:
        ws = self.clients.get(uuid)
        if ws is None:
            return
        try:
            await ws.send(json.dumps(payload))
        except Exception:  # noqa: BLE001
            pass

    async def _notify_room(self, room: str, payload: Dict[str, Any], skip: Optional[str]) -> None:
        for member in list(self.room_list.get(room, [])):
            if member != skip:
                await self._send(member, payload)

    async def handler(self, ws) -> None:
        uuid = str(uuid_module.uuid4())
        self.clients[uuid] = ws
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    await self.handle(uuid, msg)
        except Exception:  # noqa: BLE001
            pass
        finally:
            self.cleanup(uuid)

    def cleanup(self, uuid: str) -> None:
        self.clients.pop(uuid, None)
        sid = self.stream_ids.pop(uuid, None)
        if sid and self.streams.get(sid) == uuid:
            del self.streams[sid]
        room = self.rooms.pop(uuid, None)
        if room:
            if self.directors.get(room) == uuid:
                del self.directors[room]
            members = [m for m in self.room_list.get(room, []) if m != uuid]
            if members:
                self.room_list[room] = members
            else:
                self.room_list.pop(room, None)
        for key in list(self.waiting):
            self.waiting[key].discard(uuid)
            if not self.waiting[key]:
                del self.waiting[key]

    async def handle(self, uuid: str, msg: Dict[str, Any]) -> None:
        request = msg.get("request")
        if not request:
            if "leave" in msg:
                self._leave_room(uuid)
                return
            target = msg.get("UUID")
            if isinstance(target, str) and target in self.clients:
                msg["UUID"] = uuid
                msg.pop("from", None)
                await self._send(target, msg)
            return
        if request == "play":
            await self.play(uuid, str(msg.get("streamID") or "").strip())
        elif request == "seed":
            await self.seed(uuid, str(msg.get("streamID") or "").strip())
        elif request == "joinroom":
            await self.join_room(uuid, str(msg.get("roomid") or "").strip().lower(), bool(msg.get("claim")), str(msg.get("streamID") or "").strip())

    async def play(self, uuid: str, stream_id: str) -> None:
        if not stream_id:
            return
        seeder = self.streams.get(stream_id)
        if seeder is None:
            self.waiting.setdefault(stream_id, set()).add(uuid)
            return
        if seeder == uuid or seeder not in self.clients:
            if seeder not in self.clients:
                self.waiting.setdefault(stream_id, set()).add(uuid)
            return
        if seeder in self.rooms and self.rooms.get(uuid) != self.rooms[seeder]:
            self.waiting.setdefault(stream_id, set()).add(uuid)
            return
        await self._send(seeder, {"request": "offerSDP", "UUID": uuid})

    async def seed(self, uuid: str, stream_id: str) -> None:
        if not stream_id:
            return
        existing = self.stream_ids.get(uuid)
        if existing and existing != stream_id:
            await self._send(uuid, {"request": "alert", "message": "Stream ID cannot change on an existing connection."})
            return
        owner = self.streams.get(stream_id)
        if owner and owner != uuid and owner in self.clients:
            await self._send(uuid, {"request": "alert", "message": "Stream ID is already in use."})
            return
        self.streams[stream_id] = uuid
        self.stream_ids[uuid] = stream_id
        room = self.rooms.get(uuid)
        if room:
            await self._notify_room(room, {"request": "videoaddedtoroom", "UUID": uuid, "streamID": stream_id}, uuid)
        else:
            for viewer in self.waiting.pop(stream_id, set()):
                if viewer in self.clients:
                    await self._send(uuid, {"request": "offerSDP", "UUID": viewer})

    def _leave_room(self, uuid: str) -> None:
        """Drops the room membership ({"leave": true})."""
        room = self.rooms.pop(uuid, None)
        if not room:
            return
        if self.directors.get(room) == uuid:
            del self.directors[room]
        members = [m for m in self.room_list.get(room, []) if m != uuid]
        if members:
            self.room_list[room] = members
        else:
            self.room_list.pop(room, None)

    async def join_room(self, uuid: str, room: str, claim: bool, stream_id: str) -> None:
        if not room or uuid in self.rooms:
            return
        if stream_id and uuid not in self.stream_ids:
            # Same live-owner check as seed: joinroom must not take over a stream ID.
            owner = self.streams.get(stream_id)
            if owner and owner != uuid and owner in self.clients:
                await self._send(uuid, {"request": "alert", "message": "Stream ID is already in use."})
                return
            self.streams[stream_id] = uuid
            self.stream_ids[uuid] = stream_id
        self.rooms[uuid] = room
        resp: Dict[str, Any] = {"request": "listing"}
        is_director = False
        if claim:
            current = self.directors.get(room)
            if current is None or current not in self.clients:
                self.directors[room] = uuid
                resp["claim"] = True
                is_director = True
            else:
                resp["claim"] = current == uuid
                if current != uuid:
                    resp["director"] = current
        elif room in self.directors:
            resp["director"] = self.directors[room]
        members = self.room_list.setdefault(room, [])
        listing = []
        for member in members:
            entry: Dict[str, Any] = {"UUID": member}
            if member in self.stream_ids:
                entry["streamID"] = self.stream_ids[member]
            if self.directors.get(room) == member:
                entry["director"] = True
            listing.append(entry)
        resp["list"] = listing
        await self._send(uuid, resp)
        notice: Dict[str, Any] = {"request": "someonejoined", "UUID": uuid}
        if is_director:
            notice["director"] = True
        if uuid in self.stream_ids:
            notice["streamID"] = self.stream_ids[uuid]
        await self._notify_room(room, notice, uuid)
        members.append(uuid)
        sid = self.stream_ids.get(uuid)
        if sid and sid in self.waiting:
            for viewer in list(self.waiting[sid]):
                if self.rooms.get(viewer) == room:
                    self.waiting[sid].discard(viewer)
                    await self._send(uuid, {"request": "offerSDP", "UUID": viewer})


async def serve(host: str = "127.0.0.1", port: int = 0):
    """Start the server; returns the websockets server object (use ``.sockets`` for the port)."""
    server = SignalServer()
    return await websockets.serve(server.handler, host, port)


def main() -> None:
    parser = argparse.ArgumentParser(description="VDO.Ninja-compatible signaling server (development/LAN use)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)

    async def run() -> None:
        server = await serve(args.host, args.port)
        log.info("listening on ws://%s:%d", args.host, args.port)
        await server.wait_closed()

    asyncio.run(run())


if __name__ == "__main__":
    main()

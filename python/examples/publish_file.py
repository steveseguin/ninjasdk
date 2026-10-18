#!/usr/bin/env python3
# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MIT
"""Publish a media file (anything FFmpeg can read) as a VDO.Ninja stream.

    python examples/publish_file.py --file video.mp4 --stream pyfile --room myroom
    # then open https://vdo.ninja/?view=pyfile&room=myroom&scene
"""
import argparse
import asyncio

from aiortc.contrib.media import MediaPlayer

from vdoninja import VDONinja, encode_uri_component, sanitize_room


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, help="media file, device or URL FFmpeg can open")
    parser.add_argument("--stream", default=None)
    parser.add_argument("--room", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--host", default="wss://wss.vdo.ninja")
    parser.add_argument("--loop", action="store_true", default=True)
    args = parser.parse_args()

    player = MediaPlayer(args.file, loop=args.loop)
    tracks = [t for t in (player.audio, player.video) if t is not None]
    sdk = VDONinja(args.host, password=args.password, label="Python file publisher")
    sdk.on("peerConnected", lambda ev: print("viewer connected:", ev.uuid))
    sdk.on("peerDisconnected", lambda ev: print("viewer left:", ev.uuid))
    await sdk.connect()
    sid = await sdk.publish(tracks, args.stream, room=args.room)
    url = f"https://vdo.ninja/?view={sid}"
    if args.room:
        url += f"&room={sanitize_room(args.room)}&scene"
    if args.password:
        url += "&password=" + encode_uri_component(encode_uri_component(args.password))
    print("Publishing. Watch at:", url)
    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await sdk.disconnect()


if __name__ == "__main__":
    asyncio.run(main())

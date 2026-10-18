#!/usr/bin/env python3
# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MIT
"""WHIP publish / WHEP view examples.

    python examples/whip_whep.py publish https://cae1.meshcast.io/whip/mystream --file video.mp4
    python examples/whip_whep.py view https://cae1.meshcast.io/whep/mystream --out whep.mp4
"""
import argparse
import asyncio

from aiortc.contrib.media import MediaPlayer, MediaRecorder

from vdoninja import WHEPClient, WHIPClient


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["publish", "view"])
    parser.add_argument("endpoint")
    parser.add_argument("--token", default=None)
    parser.add_argument("--file", default=None)
    parser.add_argument("--out", default="whep.mp4")
    args = parser.parse_args()

    if args.mode == "publish":
        player = MediaPlayer(args.file, loop=True)
        client = WHIPClient(args.endpoint, token=args.token)
        await client.publish([t for t in (player.audio, player.video) if t])
        print("publishing to", args.endpoint)
    else:
        recorder = MediaRecorder(args.out)
        client = WHEPClient(args.endpoint, token=args.token)

        def on_track(track):
            recorder.addTrack(track)
            asyncio.ensure_future(recorder.start())

        client.on_track(on_track)
        await client.view()
        print("viewing", args.endpoint, "->", args.out)
    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        if args.mode == "view":
            await recorder.stop()
        await client.stop()


if __name__ == "__main__":
    asyncio.run(main())

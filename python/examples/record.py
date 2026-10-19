#!/usr/bin/env python3
# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MIT
"""Record a VDO.Ninja stream to a file (any container FFmpeg can write, e.g. .mp4/.mkv/.webm).

    python examples/record.py --stream mycam --room myroom --out capture.mp4
"""
import argparse
import asyncio

from aiortc.contrib.media import MediaRecorder

from vdoninja import StreamNotYetAvailable, VDONinja


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stream", required=True)
    parser.add_argument("--room", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--host", default="wss://wss.vdo.ninja")
    parser.add_argument("--out", default="recording.mp4")
    args = parser.parse_args()

    recorder = MediaRecorder(args.out)
    started = False
    sdk = VDONinja(args.host, password=args.password, label="Python recorder")

    async def on_track(ev):
        nonlocal started
        print("track:", ev.track.kind)
        recorder.addTrack(ev.track)
        if not started:
            started = True
            await recorder.start()

    sdk.on("track", on_track)
    await sdk.connect()
    if args.room:
        await sdk.join_room(args.room)
    try:
        await sdk.view(args.stream)
    except StreamNotYetAvailable:
        print("waiting for publisher ...")
    print(f"recording {args.stream} to {args.out}; Ctrl-C to stop")
    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await recorder.stop()
        await sdk.disconnect()


if __name__ == "__main__":
    asyncio.run(main())

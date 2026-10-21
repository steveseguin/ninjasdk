"""Feed a synthetic tone through the emulator's documented microphone gRPC API.
Requires grpcio-tools. Uses the emulator's own proto and discovery file; no host mic.
"""
import argparse
import importlib
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--emulator-dir", type=Path, required=True)
parser.add_argument("--discovery-file", type=Path, required=True)
args = parser.parse_args()
settings = dict(line.split("=", 1) for line in args.discovery_file.read_text().splitlines() if "=" in line)
with tempfile.TemporaryDirectory() as generated:
    subprocess.run([sys.executable, "-m", "grpc_tools.protoc", "-I" + str(args.emulator_dir / "lib"),
                    "--python_out=" + generated, "--grpc_python_out=" + generated,
                    str(args.emulator_dir / "lib/emulator_controller.proto")], check=True)
    sys.path.insert(0, generated)
    import grpc
    proto = importlib.import_module("emulator_controller_pb2")
    client = importlib.import_module("emulator_controller_pb2_grpc")
    fmt = proto.AudioFormat(samplingRate=48000, channels=proto.AudioFormat.Mono, format=proto.AudioFormat.AUD_FMT_S16)
    tone = struct.pack("<4800h", *(int(9000 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(4800)))

    def packets():
        while True:
            yield proto.AudioPacket(format=fmt, audio=tone)

    with grpc.insecure_channel("localhost:" + settings["grpc.port"]) as channel:
        client.EmulatorControllerStub(channel).injectAudio(
            packets(), metadata=[("authorization", "Bearer " + settings["grpc.token"])])

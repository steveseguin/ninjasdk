#!/usr/bin/env python3
# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MIT
"""Cross-language interoperability matrix for the VDO.Ninja SDKs.

Starts a local signaling server (the Go one by default), then for every
(publisher language, viewer language) pair runs the language's interop peer:
the publisher announces a data-only stream and echoes probes; the viewer views
it, sends a probe over the data channel, waits for the echo and performs one
request/response round trip. Every pair exercises hashing, SDP/ICE encryption,
offer/answer, trickle ICE, the control channel and the pipe protocol between
two independent implementations.

    python3 spec/interop/run_interop.py [--langs go,rust,c,python,js] [--server go|c|python|rust]

Peers that are not built or whose toolchain is missing are skipped (reported as
"skip"). Pairs listed in --known-failures are still run but reported as "known"
and do not fail the run. The default covers the one engine incompatibility we
know of: a Rust publisher (offerer) cannot connect to a Python viewer because
the rtc crate only initiates the SCTP association as the DTLS client and aiortc
only as the ICE-controlling side, so with Rust offering neither side sends the
SCTP INIT. Browsers, pion and libdatachannel initiate from either role. Set VDON_INTEROP_BUILD=0 to skip building. Environment overrides:
VDON_C_BUILD_DIR (default c/build), VDON_PYTHON (python interpreter with the
vdoninja package installed), NODE_PATH (for node-datachannel/ws when the JS
peer runs outside an npm install).
"""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
C_BUILD = os.environ.get("VDON_C_BUILD_DIR", os.path.join(ROOT, "c", "build"))
PY = os.environ.get("VDON_PYTHON", sys.executable)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def run(cmd, cwd=None, timeout=900):
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=cwd, timeout=timeout, check=False).returncode == 0


def build(langs):
    ok = {}
    if "go" in langs:
        ok["go"] = shutil.which("go") is not None and run(["go", "build", "-o", "../build-interop/go-interop", "./examples/interop"], cwd=os.path.join(ROOT, "go")) and run(
            ["go", "build", "-o", "../build-interop/go-signal", "./cmd/vdoninja-signal"], cwd=os.path.join(ROOT, "go")
        )
    if "rust" in langs:
        ok["rust"] = shutil.which("cargo") is not None and run(
            ["cargo", "build", "--release", "-p", "vdoninja", "--example", "interop", "--bin", "vdoninja-signal"], cwd=os.path.join(ROOT, "rust")
        )
    if "c" in langs:
        ok["c"] = shutil.which("cmake") is not None and run(
            ["cmake", "-S", os.path.join(ROOT, "c"), "-B", C_BUILD, "-DCMAKE_BUILD_TYPE=Release", "-DVDON_BUILD_TESTS=OFF"]
        ) and run(["cmake", "--build", C_BUILD, "--target", "vdon_interop", "vdoninja-signal", "-j4"])
    if "python" in langs:
        ok["python"] = subprocess.run([PY, "-c", "import vdoninja, aiortc"], capture_output=True).returncode == 0
    if "js" in langs:
        ok["js"] = shutil.which("node") is not None and subprocess.run(
            ["node", "-e", "require('ws'); try{require('node-datachannel')}catch(e){require('@roamhq/wrtc')}"],
            cwd=ROOT,
            capture_output=True,
        ).returncode == 0
    return ok


def peer_cmd(lang, role, stream, host):
    if lang == "go":
        return [os.path.join(ROOT, "build-interop", "go-interop"), "-role", role, "-stream", stream, "-host", host]
    if lang == "rust":
        return [os.path.join(ROOT, "rust", "target", "release", "examples", "interop"), "--role", role, "--stream", stream, "--host", host]
    if lang == "c":
        return [os.path.join(C_BUILD, "vdon_interop"), "--role", role, "--stream", stream, "--host", host]
    if lang == "python":
        return [PY, os.path.join(ROOT, "python", "examples", "interop.py"), "--role", role, "--stream", stream, "--host", host]
    if lang == "js":
        return ["node", os.path.join(ROOT, "spec", "interop", "peer.js"), "--role", role, "--stream", stream, "--host", host]
    raise ValueError(lang)


def server_cmd(kind, port):
    if kind == "go":
        return [os.path.join(ROOT, "build-interop", "go-signal"), "-addr", f"127.0.0.1:{port}"]
    if kind == "c":
        return [os.path.join(C_BUILD, "vdoninja-signal"), str(port)]
    if kind == "python":
        return [PY, "-m", "vdoninja.signalserver", "--host", "127.0.0.1", "--port", str(port)]
    if kind == "rust":
        return [os.path.join(ROOT, "rust", "target", "release", "vdoninja-signal"), f"127.0.0.1:{port}"]
    raise ValueError(kind)


def wait_port(port, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--langs", default="go,rust,c,python,js")
    parser.add_argument("--server", default="go", choices=["go", "c", "python", "rust"])
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--known-failures", default="rust:python", help="comma-separated publisher:viewer pairs reported as 'known'")
    args = parser.parse_args()
    langs = [l.strip() for l in args.langs.split(",") if l.strip()]
    known = {tuple(p.split(":")) for p in args.known_failures.split(",") if ":" in p}
    if os.environ.get("VDON_INTEROP_BUILD", "1") != "0":
        built = build(set(langs) | {args.server})
    else:
        built = {l: True for l in set(langs) | {args.server}}
    if not built.get(args.server):
        print(f"cannot build the {args.server} signaling server")
        return 2
    port = free_port()
    env = dict(os.environ, PYTHONPATH=os.path.join(ROOT, "python") + os.pathsep + os.environ.get("PYTHONPATH", ""))
    server = subprocess.Popen(server_cmd(args.server, port), env=env)
    if not wait_port(port):
        server.kill()
        print("signaling server did not start")
        return 2
    host = f"ws://127.0.0.1:{port}"
    results = {}
    try:
        for pub in langs:
            for view in langs:
                key = (pub, view)
                if not built.get(pub) or not built.get(view):
                    results[key] = "skip"
                    continue
                stream = f"interop_{pub}_{view}_{int(time.time()) % 100000}"
                print(f"\n=== publisher {pub} -> viewer {view} ({stream})", flush=True)
                p = subprocess.Popen(peer_cmd(pub, "publish", stream, host), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
                ready = False
                deadline = time.time() + 30
                while time.time() < deadline:
                    line = p.stdout.readline()
                    if not line:
                        break
                    print(f"[{pub} pub] {line.rstrip()}")
                    if "READY" in line:
                        ready = True
                        break
                if not ready:
                    p.kill()
                    results[key] = "fail (publisher not ready)"
                    continue
                try:
                    v = subprocess.run(peer_cmd(view, "view", stream, host), capture_output=True, text=True, timeout=args.timeout, env=env)
                    out = v.stdout + v.stderr
                    for line in out.strip().splitlines()[-6:]:
                        print(f"[{view} view] {line}")
                    results[key] = "ok" if v.returncode == 0 and "OK rpc" in out else "fail"
                except subprocess.TimeoutExpired:
                    results[key] = "fail (timeout)"
                finally:
                    p.kill()
                    try:
                        p.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
    finally:
        server.kill()
    print("\nInteroperability matrix (rows publish, columns view):")
    width = max(len(l) for l in langs) + 2
    print(" " * width + "".join(l.ljust(width) for l in langs))
    failed = 0
    for pub in langs:
        row = pub.ljust(width)
        for view in langs:
            r = results.get((pub, view), "skip")
            if r.startswith("fail") and (pub, view) in known:
                r = "known"
                results[(pub, view)] = r
            if r.startswith("fail"):
                failed += 1
            row += r.split(" ")[0].ljust(width)
        print(row)
    for key, r in results.items():
        if r.startswith("fail"):
            print(f"  {key[0]} -> {key[1]}: {r}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

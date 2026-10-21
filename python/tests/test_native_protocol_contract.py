"""Cross-port guard for transport extensions forbidden on hosted signaling.

Runtime round-trip tests cover the available engines. This guard also covers
mobile source trees when their platform toolchains are not installed.
"""
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PORTS = {
    "c": ["c/src/vdon_sdk.c", "c/src/vdon_sdk_data.c", "c/include/vdoninja.h", "c/src/vdon_signalserver.c"],
    "go": ["go/sdk.go", "go/data.go", "go/options.go", "go/signalserver/server.go"],
    "python": ["python/vdoninja/sdk.py", "python/vdoninja/signalserver.py"],
    "rust": ["rust/vdoninja/src/sdk.rs", "rust/vdoninja/src/options.rs", "rust/vdoninja/src/signalserver.rs"],
    "swift": ["swift/Sources/VDONinja/VDONinja.swift", "swift/Sources/VDONinjaCore/SignalingClient.swift", "swift/Sources/VDONinjaCore/Options.swift"],
    "kotlin": ["kotlin/vdoninja-android/src/main/kotlin/ninja/vdo/sdk/VdoNinja.kt", "kotlin/vdoninja-core/src/main/kotlin/ninja/vdo/sdk/core/SignalingClient.kt", "kotlin/vdoninja-core/src/main/kotlin/ninja/vdo/sdk/core/Options.kt"],
    "dart": ["dart/vdoninja/lib/src/vdoninja.dart", "dart/vdoninja_core/lib/src/signaling.dart", "dart/vdoninja_core/lib/src/options.dart"],
}


@pytest.mark.parametrize("port", PORTS)
def test_no_application_relay_or_client_identity_extension(port):
    for filename in PORTS[port]:
        source = (ROOT / filename).read_text().split("#[cfg(test)]")[0]
        for extension in ("__fallback", "allowFallback", "AllowFallback", "allow_fallback", "clientId", "ClientID", "client_id", '"leave"', "'leave'"):
            assert extension not in source, f"{filename} reintroduced {extension}"


@pytest.mark.parametrize("filename,start,end,forbidden", [
    ("c/src/vdon_sdk.c", "static void conn_bye(", "static void conn_bye_all(", "ws_send"),
    ("go/sdk.go", "func (s *SDK) closeWithBye(", "// writeWS", "sendWS"),
    ("python/vdoninja/sdk.py", "    async def _close_with_bye(", "    def _send_ws(", "_send_ws("),
    ("rust/vdoninja/src/sdk.rs", "    async fn disconnect(self: Arc<Self>)", "    fn send_ws(", "send_ws("),
    ("swift/Sources/VDONinja/VDONinja.swift", "    private func sendBye(", "\n    }", "signal.send"),
    ("kotlin/vdoninja-android/src/main/kotlin/ninja/vdo/sdk/VdoNinja.kt", "    private fun sendBye(", "\n    }", "signal.send"),
    ("dart/vdoninja/lib/src/vdoninja.dart", "  void _sendBye(", "\n  }", "_signal.send"),
])
def test_bye_does_not_fall_back_to_signaling(filename, start, end, forbidden):
    source = (ROOT / filename).read_text()
    body = source.split(start, 1)[1].split(end, 1)[0]
    assert forbidden not in body, f"{filename} routes bye through signaling"
    assert '"bye"' in body or "'bye'" in body

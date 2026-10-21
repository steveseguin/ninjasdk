#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
flutter create --platforms web --project-name vdon_browser_peer "$fixture"
cd "$fixture"
flutter pub add "vdoninja:{path: $root/dart/vdoninja}" flutter_webrtc
cp "$root/dart/vdoninja/test/browser_peer.dart" lib/main.dart
flutter build web --output "$root/build-interop/flutter/web"

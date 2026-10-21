// swift-tools-version:5.9
// VDO.Ninja SDK for Swift
// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import PackageDescription

let package = Package(
    name: "VDONinja",
    platforms: [.iOS(.v14), .macOS(.v11), .tvOS(.v14)],
    products: [
        // Protocol core without WebRTC: hashing, encryption, sanitization, signaling, TURN. Builds everywhere, including Linux.
        .library(name: "VDONinjaCore", targets: ["VDONinjaCore"]),
        // The SDK on Google's WebRTC (stasel/WebRTC binary package). Apple platforms only.
        .library(name: "VDONinja", targets: ["VDONinja"]),
    ],
    dependencies: webrtcDependencies,
    targets: [
        .target(name: "VDONinjaCore", dependencies: []),
        .target(name: "VDONinja", dependencies: ["VDONinjaCore"] + webrtcProduct),
        .testTarget(name: "VDONinjaCoreTests", dependencies: ["VDONinjaCore"]),
    ] + browserTestTargets
)

// The WebRTC binary package only exists for Apple platforms. On Linux the
// package still builds (core + tests); the VDONinja target compiles to nothing.
#if os(Linux)
var browserTestTargets: [Target] { [] }
var webrtcDependencies: [Package.Dependency] { [] }
var webrtcProduct: [Target.Dependency] { [] }
#else
var browserTestTargets: [Target] { [.executableTarget(name: "BrowserPeer", dependencies: ["VDONinja"] + webrtcProduct, path: "Tests/BrowserPeer")] }
var webrtcDependencies: [Package.Dependency] { [.package(url: "https://github.com/stasel/WebRTC.git", from: "137.0.0")] }
var webrtcProduct: [Target.Dependency] { [.product(name: "WebRTC", package: "WebRTC")] }
#endif

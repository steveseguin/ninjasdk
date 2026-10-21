// VDO.Ninja SDK for Kotlin / Java
// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "vdoninja"

include(":vdoninja-core")

// The Android library needs an Android SDK; it is skipped when none is configured
// so the pure-JVM core can be built and tested anywhere.
val sdkDir = System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
    ?: file("local.properties").takeIf { it.exists() }?.readLines()
        ?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")
if (sdkDir != null && file(sdkDir).exists()) {
    include(":vdoninja-android")
} else {
    logger.lifecycle("ANDROID_HOME not set: skipping :vdoninja-android")
}

// Opt-in live browser interoperability fixture; excluded from normal SDK builds.
if (providers.gradleProperty("browserTest").isPresent) include(":browser-test")

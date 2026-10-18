// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ninja.vdo.sdk"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    publishing {
        singleVariant("release") { withSourcesJar() }
    }
}

dependencies {
    api(project(":vdoninja-core"))
    // Google's libwebrtc, kept current by Stream (BSD-3-Clause).
    api("io.getstream:stream-webrtc-android:1.3.10")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

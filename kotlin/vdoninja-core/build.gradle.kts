// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
plugins {
    id("org.jetbrains.kotlin.jvm")
    `java-library`
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    // org.json ships with Android; on the JVM it must be provided by the consumer.
    compileOnly("org.json:json:20250517")
    api("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("org.json:json:20250517")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("vdon.vectors", rootProject.file("../spec/vectors.json").absolutePath)
}

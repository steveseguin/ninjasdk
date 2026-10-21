// Test-only Android peer for tests/interop/native-av-live.cjs.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "ninja.vdo.browsertest"
    compileSdk = 35
    defaultConfig { applicationId = "ninja.vdo.browsertest"; minSdk = 24; targetSdk = 32 }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies { implementation(project(":vdoninja-android")) }

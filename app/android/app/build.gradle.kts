import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val signingProperties = Properties()
val signingPropertiesFile = rootProject.file("key.properties")
if (signingPropertiesFile.exists()) {
    signingPropertiesFile.inputStream().use { signingProperties.load(it) }
}
val signingValues = mapOf(
    "storeFile" to (System.getenv("ANDROID_KEYSTORE_PATH") ?: signingProperties.getProperty("storeFile")),
    "storePassword" to (System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: signingProperties.getProperty("storePassword")),
    "keyAlias" to (System.getenv("ANDROID_KEY_ALIAS") ?: signingProperties.getProperty("keyAlias")),
    "keyPassword" to (System.getenv("ANDROID_KEY_PASSWORD") ?: signingProperties.getProperty("keyPassword")),
)
val hasReleaseSigning = signingValues.values.all { !it.isNullOrBlank() }
check(!signingValues.values.any { !it.isNullOrBlank() } || hasReleaseSigning) {
    "Release signing configuration is incomplete. Configure all four signing values."
}
check(System.getenv("REQUIRE_RELEASE_SIGNING") != "true" || hasReleaseSigning) {
    "Release signing is required; refusing to publish an APK signed with the debug key."
}

android {
    namespace = "com.mitchel.claude_monitor"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        // Required by flutter_local_notifications (uses java.time on older APIs).
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.mitchel.claude_monitor"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(signingValues.getValue("storeFile")!!)
                storePassword = signingValues.getValue("storePassword")
                keyAlias = signingValues.getValue("keyAlias")
                keyPassword = signingValues.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Local release-mode runs may use debug signing; publishing requires the explicit CI guard.
            signingConfig = signingConfigs.getByName(if (hasReleaseSigning) "release" else "debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    // Backport of java.time etc. for flutter_local_notifications on low API levels.
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    // MonitorService's WebSocket client + ApprovalReceiver's REST calls.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

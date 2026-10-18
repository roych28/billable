import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform")
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(21)
}

dependencies {
    testImplementation("junit:junit:4.13.2")

    intellijPlatform {
        intellijIdeaCommunity(providers.gradleProperty("platformVersion"))
        testFramework(TestFrameworkType.Platform)
    }
}

val paid = providers.gradleProperty("cmaPaid").map { it.toBoolean() }.getOrElse(false)

// JetBrains' rules for a paid plugin (plugins.jetbrains.com/docs/marketplace/add-required-parameters.html and
// versioning-of-paid-plugins.html): the code is P plus 3-14 capital letters, and the version starts with the digits
// of release-version, e.g. version 2026.1.0 with release-version 20261. Fail early rather than at upload.
if (paid) {
    val code = providers.gradleProperty("cmaProductCode").get()
    val releaseVersion = providers.gradleProperty("cmaReleaseVersion").get()
    val pluginVersion = providers.gradleProperty("pluginVersion").get()
    require(Regex("^P[A-Z]{3,14}$").matches(code)) { "cmaProductCode must be P plus 3-14 capital letters: $code" }
    require(Regex("^\\d{2,}$").matches(releaseVersion)) { "cmaReleaseVersion must be digits: $releaseVersion" }
    require(pluginVersion.filter { it.isDigit() }.startsWith(releaseVersion)) {
        "pluginVersion $pluginVersion must start with the release-version $releaseVersion (e.g. 2026.1.0 for 20261)"
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
        if (paid) {
            // optional = true: the plugin keeps working without a license (freemium); only Pro features ask for one.
            productDescriptor {
                code = providers.gradleProperty("cmaProductCode")
                releaseDate = providers.gradleProperty("cmaReleaseDate")
                releaseVersion = providers.gradleProperty("cmaReleaseVersion")
                optional = true
            }
        }
    }
    // Verified against the IDE it is compiled with, already in the Gradle cache. Add a newer IDE here before a
    // release (each one is a download of about 1 GB).
    pluginVerification {
        ides {
            create(IntelliJPlatformType.IntellijIdeaCommunity, providers.gradleProperty("platformVersion"))
        }
    }
}

tasks.test {
    // The tests never touch the real ~/.claude* or ~/.claude-multi-account. The unit tests pass a temp home and an
    // explicit environment; the plugin, loaded in a headless IDE, gets a throwaway home and setup folder here.
    val sandbox = layout.buildDirectory.dir("cma-test-home").get().asFile
    doFirst {
        sandbox.deleteRecursively()
        sandbox.mkdirs()
    }
    systemProperty("cma.home", sandbox.absolutePath)
    environment("CLAUDE_MULTI_ACCOUNT_HOME", sandbox.resolve(".claude-multi-account").absolutePath)
}

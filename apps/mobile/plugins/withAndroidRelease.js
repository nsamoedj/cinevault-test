// Release builds: sign with our own upload key when the build is given one,
// and take the versionCode from the build (the CI run number), so that each
// new APK installs over the previous one. Both come in as Gradle properties
// (or ORG_GRADLE_PROJECT_* environment variables); the keystore itself is
// never part of the repository. Without a key the release is signed with the
// template's debug key, as Expo does by default.
//
// For scripts/build-apk.ps1 (cinevault.splitApks=true): one build gives the
// phone APK (arm64-v8a) and the TV APK (all ABIs) as ABI splits, instead of
// two builds of the same code. Release builds skip lint (lintVital), which
// took minutes and only warns.

const { withAppBuildGradle } = require('expo/config-plugins');

const SIGNING = `signingConfigs {
        if (findProperty('CINEVAULT_UPLOAD_STORE_FILE')) {
            release {
                storeFile file(findProperty('CINEVAULT_UPLOAD_STORE_FILE'))
                storePassword findProperty('CINEVAULT_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('CINEVAULT_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('CINEVAULT_UPLOAD_KEY_PASSWORD')
            }
        }`;

const SPEED = `
// CineVault (plugins/withAndroidRelease.js): ABI splits for scripts/build-apk.ps1, no lint on release.
android {
    lint {
        checkReleaseBuilds false
    }
    if (findProperty('cinevault.splitApks') == 'true') {
        splits {
            abi {
                enable true
                reset()
                include(*((findProperty('reactNativeArchitectures') ?: 'armeabi-v7a,arm64-v8a').split(',')))
                universalApk true
            }
        }
    }
}
`;

function replaceOnce(source, pattern, replacement, what) {
  if (!pattern.test(source))
    throw new Error(`withAndroidRelease: ${what} not found in app/build.gradle`);
  return source.replace(pattern, replacement);
}

module.exports = function withAndroidRelease(config) {
  return withAppBuildGradle(config, (config) => {
    let gradle = config.modResults.contents;
    if (!gradle.includes('cinevault.splitApks')) gradle += SPEED;
    if (gradle.includes('CINEVAULT_UPLOAD_STORE_FILE')) {
      config.modResults.contents = gradle;
      return config;
    }
    gradle = replaceOnce(gradle, /signingConfigs \{/, SIGNING, 'signingConfigs');
    gradle = replaceOnce(
      gradle,
      /(release \{[^}]*?)signingConfig signingConfigs\.debug/,
      "$1signingConfig findProperty('CINEVAULT_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug",
      'release signingConfig',
    );
    gradle = replaceOnce(
      gradle,
      /versionCode (\d+)/,
      "versionCode((findProperty('cinevault.versionCode') ?: '$1') as Integer)",
      'versionCode',
    );
    config.modResults.contents = gradle;
    return config;
  });
};

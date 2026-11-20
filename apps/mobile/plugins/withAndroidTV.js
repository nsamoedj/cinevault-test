// Android TV: the same APK also installs on a TV and shows up in its launcher.
// It adds the LEANBACK_LAUNCHER category to the main activity, says that
// leanback and a touchscreen are optional (so neither phones nor TVs are
// excluded), and gives the app the 320x180 banner the TV launcher shows.
// The app itself switches to its TV screens with Platform.isTV.

const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const BANNER = 'assets/tv-banner.png';

function withTvManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    manifest['uses-feature'] = manifest['uses-feature'] ?? [];
    for (const name of ['android.software.leanback', 'android.hardware.touchscreen']) {
      if (!manifest['uses-feature'].some((feature) => feature.$['android:name'] === name)) {
        manifest['uses-feature'].push({ $: { 'android:name': name, 'android:required': 'false' } });
      }
    }

    const application = manifest.application?.[0];
    if (!application) throw new Error('withAndroidTV: no <application> in AndroidManifest.xml');
    application.$['android:banner'] = '@drawable/tv_banner';

    const main = (application.activity ?? []).find(
      (activity) => activity.$['android:name'] === '.MainActivity',
    );
    const launcher = main?.['intent-filter']?.find((filter) =>
      filter.action?.some((action) => action.$['android:name'] === 'android.intent.action.MAIN'),
    );
    if (!launcher) throw new Error('withAndroidTV: no MAIN intent filter on .MainActivity');
    launcher.category = launcher.category ?? [];
    if (
      !launcher.category.some(
        (category) => category.$['android:name'] === 'android.intent.category.LEANBACK_LAUNCHER',
      )
    ) {
      launcher.category.push({
        $: { 'android:name': 'android.intent.category.LEANBACK_LAUNCHER' },
      });
    }
    return config;
  });
}

function withTvBanner(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const target = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/res/drawable-xhdpi/tv_banner.png',
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(config.modRequest.projectRoot, BANNER), target);
      return config;
    },
  ]);
}

module.exports = function withAndroidTV(config) {
  return withTvBanner(withTvManifest(config));
};

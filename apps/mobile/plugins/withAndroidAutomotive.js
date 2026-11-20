// Android Automotive OS (cars with Google built-in, such as Polestar and
// Volvo): the same app and APK, also for Google Play. A parked video app may
// share the phone's release (developer.android.com/training/cars/distribute):
//
// - android.hardware.type.automotive, not required: phones and TVs keep it;
// - android:appCategory="video" on <application>;
// - none of the features cars may lack required (Wi-Fi, a camera, a fixed
//   portrait or landscape screen);
// - android.car as an optional library, for the driving restrictions
//   (modules/cinevault-media; video only while parked).
//
// distractionOptimized only in the car's own build (CINEVAULT_CAR=1, from
// scripts/build-apk.sh --variant car; owner's request 2026-11-20): the main
// activity and expo-video's full-screen player, landscape only. The system then
// no longer covers the app while the car drives; the player still pauses video
// itself (src/car.ts, useDrivingRestricted). Google's guidelines don't allow
// the flag for video apps, so Play may refuse the bundle. Every other build
// (phone, TV, a bundle next to the APKs) removes the flag.

/* global process */
const { withAndroidManifest } = require('expo/config-plugins');

const FLAG = 'distractionOptimized';
const VIDEO_ACTIVITY = 'expo.modules.video.FullscreenPlayerActivity';
const CONFIG_CHANGES = [
  'keyboard',
  'keyboardHidden',
  'orientation',
  'screenLayout',
  'screenSize',
  'smallestScreenSize',
  'uiMode',
];

function addFlag(activity) {
  activity['meta-data'] = activity['meta-data'] ?? [];
  if (!activity['meta-data'].some((m) => m.$['android:name'] === FLAG))
    activity['meta-data'].push({ $: { 'android:name': FLAG, 'android:value': 'true' } });
}

function carActivities(manifest, application) {
  manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
  application.activity = application.activity ?? [];
  for (const activity of application.activity) {
    if (!(activity.$['android:name'] ?? '').endsWith('MainActivity')) continue;
    addFlag(activity);
    activity.$['android:screenOrientation'] = 'sensorLandscape';
    // Added to what Expo sets (that has more, such as assetsPaths).
    const changes = new Set((activity.$['android:configChanges'] ?? '').split('|').filter(Boolean));
    for (const change of CONFIG_CHANGES) changes.add(change);
    activity.$['android:configChanges'] = [...changes].join('|');
  }
  // expo-video declares this activity in its own manifest; merged with it.
  let video = application.activity.find((a) => a.$['android:name'] === VIDEO_ACTIVITY);
  if (!video) {
    video = { $: { 'android:name': VIDEO_ACTIVITY, 'tools:node': 'merge' } };
    application.activity.push(video);
  }
  addFlag(video);
}

const OPTIONAL_FEATURES = [
  'android.hardware.type.automotive',
  'android.hardware.wifi',
  'android.hardware.camera',
  'android.hardware.screen.portrait',
  'android.hardware.screen.landscape',
];

module.exports = function withAndroidAutomotive(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest['uses-feature'] = manifest['uses-feature'] ?? [];
    for (const name of OPTIONAL_FEATURES) {
      const feature = manifest['uses-feature'].find((f) => f.$['android:name'] === name);
      if (feature) feature.$['android:required'] = 'false';
      else
        manifest['uses-feature'].push({ $: { 'android:name': name, 'android:required': 'false' } });
    }

    const application = manifest.application?.[0];
    if (!application)
      throw new Error('withAndroidAutomotive: no <application> in AndroidManifest.xml');
    application.$['android:appCategory'] = 'video';
    application['uses-library'] = application['uses-library'] ?? [];
    if (!application['uses-library'].some((l) => l.$['android:name'] === 'android.car')) {
      application['uses-library'].push({
        $: { 'android:name': 'android.car', 'android:required': 'false' },
      });
    }
    if (process.env.CINEVAULT_CAR === '1') {
      carActivities(manifest, application);
      return config;
    }
    for (const activity of application.activity ?? []) {
      activity['meta-data'] = (activity['meta-data'] ?? []).filter(
        (m) => m.$['android:name'] !== FLAG,
      );
    }
    return config;
  });
};

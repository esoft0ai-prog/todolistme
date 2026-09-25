/**
 * Finora Android hardening config plugin.
 *
 * Applied by `npx expo prebuild`, so the generated android/ project is always
 * reproducible from source. It:
 *  1. Signs release builds with the key described in android/keystore.properties
 *     (or FINORA_* environment variables). Falls back to the debug key with a
 *     loud warning so `./gradlew assembleRelease` still works for local testing.
 *  2. Removes INTERNET and ACCESS_NETWORK_STATE from *release* builds — the app is
 *     fully offline, so Android itself guarantees no data can leave the device.
 *  3. Removes the Firebase messaging service that expo-notifications declares
 *     (Finora only uses local notifications).
 *  4. Blocks Android cloud backup AND device-to-device transfer of app data
 *     (the encrypted DB key lives in the Keystore and would not transfer anyway).
 *  5. Declares exact-alarm permissions so reminders fire on time on Android 12+.
 *  6. Names APKs Finora-<version>-<buildType>.apk.
 */
const { withAndroidManifest, withAppBuildGradle, withDangerousMod, AndroidConfig } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SIGNING_MARKER = '// finora-release-signing';

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(SIGNING_MARKER)) return cfg;

    const loader = `
${SIGNING_MARKER}
def finoraKeystoreProps = new Properties()
def finoraKeystoreFile = rootProject.file("keystore.properties")
if (finoraKeystoreFile.exists()) {
    finoraKeystoreFile.withInputStream { finoraKeystoreProps.load(it) }
}
def finoraSigningValue = { String key, String envKey ->
    def v = finoraKeystoreProps.getProperty(key)
    return v != null ? v : System.getenv(envKey)
}
def finoraStoreFile = finoraSigningValue("storeFile", "FINORA_KEYSTORE_FILE")
def finoraHasReleaseKey = finoraStoreFile != null && file(finoraStoreFile).exists()
if (!finoraHasReleaseKey) {
    logger.warn("Finora: no release keystore configured (android/keystore.properties or FINORA_KEYSTORE_FILE). Release APK will be signed with the DEBUG key — fine for testing, not for distribution.")
}
`;
    src = src.replace(/android\s*\{/, (m) => `${loader}\n${m}`);

    src = src.replace(/signingConfigs\s*\{/, (m) =>
      `${m}
        release {
            if (finoraHasReleaseKey) {
                storeFile file(finoraStoreFile)
                storePassword finoraSigningValue("storePassword", "FINORA_KEYSTORE_PASSWORD")
                keyAlias finoraSigningValue("keyAlias", "FINORA_KEY_ALIAS")
                keyPassword finoraSigningValue("keyPassword", "FINORA_KEY_PASSWORD")
            }
        }`,
    );

    // In the release buildType, use the release key when available.
    src = src.replace(/(release\s*\{[^{}]*?)signingConfig\s+signingConfigs\.debug/s, (_m, pre) => `${pre}signingConfig finoraHasReleaseKey ? signingConfigs.release : signingConfigs.debug`);

    if (!src.includes('outputFileName')) {
      src += `
// Friendly APK names: Finora-<version>-<buildType>.apk
android.applicationVariants.all { variant ->
    variant.outputs.all { output ->
        outputFileName = "Finora-\${variant.versionName}-\${variant.buildType.name}.apk"
    }
}
`;
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

function withManifestHardening(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$ = manifest.$ || {};
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    // Exact alarms: SCHEDULE_EXACT_ALARM up to Android 12L, USE_EXACT_ALARM (auto-granted, reminder/calendar apps) on 13+.
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    const perms = manifest['uses-permission'];
    const add = (name, extra = {}) => {
      if (!perms.some((p) => p.$['android:name'] === name)) perms.push({ $: { 'android:name': name, ...extra } });
    };
    add('android.permission.SCHEDULE_EXACT_ALARM', { 'android:maxSdkVersion': '32' });
    add('android.permission.USE_EXACT_ALARM');

    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:allowBackup'] = 'false';
    app.$['android:fullBackupContent'] = 'false';
    app.$['android:dataExtractionRules'] = '@xml/finora_data_extraction_rules';
    app.$['tools:replace'] = 'android:allowBackup,android:fullBackupContent,android:dataExtractionRules';

    // Local notifications only: drop the FCM service declared by expo-notifications.
    app.service = app.service || [];
    const fcm = 'expo.modules.notifications.service.ExpoFirebaseMessagingService';
    if (!app.service.some((s) => s.$['android:name'] === fcm)) {
      app.service.push({ $: { 'android:name': fcm, 'tools:node': 'remove' } });
    }
    return cfg;
  });
}

function withResourceFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const xmlDir = path.join(root, 'app/src/main/res/xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'finora_data_extraction_rules.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<!-- Finora: financial data must never leave the device through Android backup or device transfer. -->
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="root" />
        <exclude domain="file" />
        <exclude domain="database" />
        <exclude domain="sharedpref" />
        <exclude domain="external" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" />
        <exclude domain="file" />
        <exclude domain="database" />
        <exclude domain="sharedpref" />
        <exclude domain="external" />
    </device-transfer>
</data-extraction-rules>
`,
      );
      // Release-only manifest overlay: no network access at all.
      const releaseDir = path.join(root, 'app/src/release');
      fs.mkdirSync(releaseDir, { recursive: true });
      fs.writeFileSync(
        path.join(releaseDir, 'AndroidManifest.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<!-- Finora release builds are 100% offline: remove network permissions entirely. -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.INTERNET" tools:node="remove" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" tools:node="remove" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" tools:node="remove" />
</manifest>
`,
      );
      // Keep ProGuard/R8 rules for native modules resolved through reflection.
      const proguard = path.join(root, 'app/proguard-rules.pro');
      if (fs.existsSync(proguard)) {
        let rules = fs.readFileSync(proguard, 'utf8');
        if (!rules.includes('# finora-rules')) {
          rules += `
# finora-rules
# SQLCipher / expo-sqlite JNI bindings
-keep class expo.modules.sqlite.** { *; }
# Local notifications are (de)serialized from SharedPreferences; keep their classes intact.
-keep class expo.modules.notifications.** { *; }
-dontwarn com.google.firebase.**
`;
          fs.writeFileSync(proguard, rules);
        }
      }
      return cfg;
    },
  ]);
}

module.exports = function withFinoraAndroid(config) {
  config = withReleaseSigning(config);
  config = withManifestHardening(config);
  config = withResourceFiles(config);
  return config;
};

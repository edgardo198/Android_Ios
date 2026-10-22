const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function pluginHarness() {
  const mods = new Map(); const writes = new Map();
  const directory = path.join(__dirname, '../plugins');
  const filename = path.join(directory, 'withCallService.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, __dirname: directory,
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'node:fs') return {
        readdirSync: fs.readdirSync, readFileSync: fs.readFileSync,
        mkdirSync() {}, writeFileSync(destination, content) { writes.set(destination, content.toString()); },
      };
      assert.equal(name, 'expo/config-plugins');
      return {
        withAndroidManifest(config, callback) { mods.set('manifest', callback); return config; },
        withMainApplication(config, callback) { mods.set('application', callback); return config; },
        withDangerousMod(config, [platform, callback]) { assert.equal(platform, 'android'); mods.set('sources', callback); return config; },
      };
    },
  }, { filename });
  module.exports({});
  return { mods, writes };
}

test('repeated prebuild adds one private service, explicit camera/mic types and required permissions', () => {
  const h = pluginHarness();
  const result = { modResults: { manifest: { application: [{ service: [{ $: { 'android:name': 'OtherService' } }] }],
    'uses-permission': [{ $: { 'android:name': 'android.permission.CAMERA' } }] } } };
  h.mods.get('manifest')(result); h.mods.get('manifest')(result);
  const manifest = result.modResults.manifest;
  const names = manifest['uses-permission'].map((entry) => entry.$['android:name']);
  assert.equal(new Set(names).size, names.length);
  for (const permission of ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_CAMERA', 'FOREGROUND_SERVICE_MICROPHONE',
    'CAMERA', 'RECORD_AUDIO', 'WAKE_LOCK', 'MODIFY_AUDIO_SETTINGS', 'POST_NOTIFICATIONS', 'BLUETOOTH_CONNECT', 'FOREGROUND_SERVICE_REMOTE_MESSAGING', 'ACCESS_NETWORK_STATE', 'INTERNET']) {
    assert.ok(names.includes(`android.permission.${permission}`), permission);
  }
  assert.equal(manifest.application[0].service.length, 3);
  const service = manifest.application[0].service.find((item) => item.$['android:name'] === 'com.chatlocal.calls.CallService');
  assert.equal(service.$['android:foregroundServiceType'], 'microphone|camera');
  assert.equal(service.$['android:exported'], 'false');
  const receiver = manifest.application[0].service.find((item) => item.$['android:name'] === 'com.chatlocal.calls.NoticeService');
  assert.equal(receiver.$['android:foregroundServiceType'], 'remoteMessaging');
  assert.equal(receiver.$['android:exported'], 'false');
  assert.equal(receiver.$['android:stopWithTask'], 'false');
});

test('Expo RN86 Kotlin package registration survives repeated prebuild without duplicating the package', () => {
  const h = pluginHarness();
  const contents = 'package example\n\nimport com.facebook.react.PackageList\nclass MainApplication {\n  fun packages() = PackageList(this).packages.apply {\n    // Expo Kotlin package registration block.\n  }\n}\n';
  const result = { modResults: { language: 'kt', contents } };
  h.mods.get('application')(result); h.mods.get('application')(result);
  assert.equal((result.modResults.contents.match(/import com.chatlocal.calls.CallPackage/g) || []).length, 1);
  assert.equal((result.modResults.contents.match(/add\(CallPackage\(\)\)/g) || []).length, 1);
  assert.throws(() => h.mods.get('application')({ modResults: { language: 'kt', contents: 'package example\nclass MainApplication' } }), /registration block/);
});

test('prebuild copies persistent Kotlin templates to the package path without modifying unrelated files', () => {
  const h = pluginHarness();
  const platformProjectRoot = path.join(__dirname, '..', '.plugin-test-android');
  h.mods.get('sources')({ modRequest: { platformProjectRoot } });
  assert.equal(h.writes.size, 7);
  for (const name of ['CallAudioRoutes.kt', 'CallPackage.kt', 'CallService.kt', 'CallSessionModule.kt', 'NoticeModule.kt', 'NoticeService.kt', 'NoticeStore.kt']) {
    const destination = path.join(platformProjectRoot, 'app/src/main/java/com/chatlocal/calls', name);
    assert.equal(h.writes.get(destination), fs.readFileSync(path.join(__dirname, '../plugins/call-service/android', name), 'utf8'));
  }
});

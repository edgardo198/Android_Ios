const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(apiUrl) {
  const mods = new Map();
  const module = { exports: {} };
  const filename = path.join(__dirname, '../plugins/withApiTransport.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, URL, process: { env: { EXPO_PUBLIC_API_URL: apiUrl } },
    require(name) {
      assert.equal(name, 'expo/config-plugins');
      return {
        withAndroidManifest(config, callback) { mods.set('manifest', callback); return config; },
        withAppBuildGradle(config, callback) { mods.set('gradle', callback); return config; },
      };
    },
  }, { filename });
  module.exports({});
  return mods;
}

function manifest() {
  return { modResults: { manifest: {
    application: [{ $: { 'android:name': '.MainApplication', 'android:label': 'Mensajeria' },
      service: [{ $: { 'android:name': 'com.chatlocal.calls.CallService' } }] }],
    'uses-permission': [{ $: { 'android:name': 'android.permission.RECORD_AUDIO' } }],
  } } };
}

test('HTTP LAN release explicitly permits API traffic without changing call service or permissions', () => {
  const result = manifest();
  harness('http://192.168.0.107:8000').get('manifest')(result);
  assert.equal(result.modResults.manifest.application[0].$['android:usesCleartextTraffic'], 'true');
  assert.equal(result.modResults.manifest.application[0].$['android:name'], '.MainApplication');
  assert.equal(result.modResults.manifest.application[0].service[0].$['android:name'], 'com.chatlocal.calls.CallService');
  assert.equal(result.modResults.manifest['uses-permission'][0].$['android:name'], 'android.permission.RECORD_AUDIO');
});

test('a new HTTPS build removes a previous HTTP exception; repeated prebuild stays stable', () => {
  const result = manifest();
  harness('http://192.168.0.107:8000').get('manifest')(result);
  const secure = harness('https://chat.example.org').get('manifest');
  secure(result); secure(result);
  assert.equal(result.modResults.manifest.application[0].$['android:usesCleartextTraffic'], 'false');
  assert.equal(result.modResults.manifest.application.length, 1);
  assert.equal(result.modResults.manifest.application[0].service.length, 1);
});

test('missing API configuration keeps the main manifest protected', () => {
  for (const value of [undefined, '', '  ']) {
    const result = manifest();
    harness(value).get('manifest')(result);
    assert.equal(result.modResults.manifest.application[0].$['android:usesCleartextTraffic'], 'false');
  }
});

test('unsafe API addresses never become a transport exception or Gradle configuration', () => {
  for (const value of ['localhost:8000', 'file:///tmp/api', 'ftp://api.example.org',
    'http://alice:password@example.org', 'https://alice@example.org', 'http://@example.org',
    'https://api.example.org?token=secret', 'https://api.example.org?',
    'https://api.example.org#fragment', 'https://api.example.org#', 'https://api.example.org/a b',
    'http://api.example.org\\path', 'http://api.example.org:0', 'http://api.example.org:65536', 'http://']) {
    assert.throws(() => harness(value), /URL HTTP o HTTPS/, value);
  }
});

test('API and bundling environment changes invalidate only the RN bundle task across repeated prebuild', () => {
  const original = 'apply plugin: "com.facebook.react"\nandroid { namespace "example" }\n';
  const result = { modResults: { language: 'groovy', contents: original } };
  const callback = harness('https://chat.example.org').get('gradle');
  callback(result); callback(result);
  assert.ok(result.modResults.contents.startsWith(original));
  assert.equal((result.modResults.contents.match(/tasks\.withType\(com\.facebook\.react\.tasks\.BundleHermesCTask\)/g) || []).length, 1);
  for (const name of ['EXPO_PUBLIC_API_URL', 'NODE_ENV', 'BABEL_ENV', 'EXPO_NO_CLIENT_ENV_VARS']) {
    assert.ok(result.modResults.contents.includes(`providers.environmentVariable("${name}")`), name);
  }
  assert.doesNotMatch(result.modResults.contents, /signingConfigs|applicationId|org\.jitsi|assembleRelease|rerun-tasks/);
});

test('unsupported templates fail with a useful error rather than generating a broken native project', () => {
  const mods = harness('https://chat.example.org');
  assert.throws(() => mods.get('manifest')({ modResults: { manifest: {} } }), /application/);
  assert.throws(() => mods.get('gradle')({ modResults: { language: 'kotlin', contents: '' } }), /Gradle Groovy/);
});

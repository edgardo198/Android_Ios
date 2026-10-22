const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const windows = process.platform === 'win32';
const scriptPath = path.resolve(__dirname, '../../scripts/build-android.ps1');
const harnessPath = path.join(__dirname, 'fixtures/android-build-harness.ps1');

function exerciseBuild(scenario) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlocal-android-build-'));
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harnessPath], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CHATLOCAL_TEST_BUILD_SCRIPT: scriptPath,
        CHATLOCAL_TEST_BUILD_CASE: scenario, CHATLOCAL_TEST_BUILD_DIRECTORY: directory },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
    const line = result.stdout.split(/\r?\n/).findLast((value) => value.startsWith('ANDROID_BUILD_RESULT='));
    assert.ok(line, result.stdout);
    return JSON.parse(line.slice('ANDROID_BUILD_RESULT='.length));
  } finally {
    // Remove only the uniquely created fixture directory, never Android outputs or the workspace.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('chatlocal-android-build-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('release API validation rejects credentials and malformed URLs before calling Expo or Gradle', { skip: !windows }, () => {
  const result = exerciseBuild('validation');
  assert.deepEqual(result.valid, ['http://192.168.0.107:8000', 'https://chat.example.org']);
  assert.equal(result.rejected, result.total);
  assert.equal(result.empty, null);
});

test('release scopes API and production mode, validates both ABIs, and keeps install -r', { skip: !windows }, () => {
  const result = exerciseBuild('release');
  assert.equal(result.failure, null);
  assert.equal(result.restored, true);
  assert.equal(result.commands.length, 2);
  assert.ok(result.commands[0].arguments.includes('prebuild'));
  assert.ok(result.commands[1].arguments.includes(':app:assembleRelease'));
  assert.ok(!result.commands[1].arguments.some((value) => value.includes('reactNativeDevServerPort')));
  for (const command of result.commands) {
    assert.equal(command.apiUrl, 'http://192.168.0.107:8000');
    assert.equal(command.nodeEnv, 'production');
    assert.equal(command.babelEnv, 'production');
    assert.equal(command.inlineEnv, '0');
  }
  assert.equal(result.installations.length, 1);
  assert.deepEqual(result.installations[0].slice(0, 4), ['-s', 'fixture-phone', 'install', '-r']);
  assert.ok(result.installations[0].at(-1).endsWith('app-release.apk'));
});

test('debug keeps Metro and accepts a development APK without an embedded bundle', { skip: !windows }, () => {
  const result = exerciseBuild('debug');
  assert.equal(result.failure, null);
  assert.equal(result.restored, true);
  assert.ok(result.commands[1].arguments.includes(':app:assembleDebug'));
  assert.ok(result.commands[1].arguments.includes('-PreactNativeDevServerPort=8081'));
  assert.equal(result.commands[1].nodeEnv, 'original-node-env');
  assert.equal(result.commands[1].inlineEnv, '1');
  assert.equal(result.installations.length, 1);
});

test('missing or empty release bundle and missing WebRTC ABI block installation and restore environment', { skip: !windows }, () => {
  for (const scenario of ['no-bundle', 'empty-bundle', 'missing-abi']) {
    const result = exerciseBuild(scenario);
    assert.match(result.failure, /index\.android\.bundle|lib\/armeabi-v7a\/libjingle_peerconnection_so\.so/);
    assert.equal(result.installations.length, 0);
    assert.equal(result.restored, true);
  }
});

test('failed prebuild restores API overrides without invoking Gradle or installation', { skip: !windows }, () => {
  const result = exerciseBuild('prebuild-failure');
  assert.equal(result.failure, 'fixture prebuild failure');
  assert.equal(result.commands.length, 1);
  assert.equal(result.installations.length, 0);
  assert.equal(result.restored, true);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');

const filename = path.join(__dirname, '../src/core/notifications.js');
const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
  filename,
  configFile: false,
  babelrc: false,
  plugins: [require('@babel/plugin-transform-modules-commonjs')],
});

function notificationHarness(options = {}) {
  const calls = { imports: 0, handlers: [], channels: [], permissions: 0, requests: 0, tokens: [], alerts: [], warnings: [] };
  const notifications = {
    AndroidImportance: { HIGH: 4 },
    setNotificationHandler(handler) { calls.handlers.push(handler); },
    async setNotificationChannelAsync(...args) { calls.channels.push(args); },
    async getPermissionsAsync() {
      calls.permissions += 1;
      return { status: options.permission || 'granted' };
    },
    async requestPermissionsAsync() {
      calls.requests += 1;
      return { status: options.requestedPermission || 'granted' };
    },
    async getExpoPushTokenAsync(parameters) {
      calls.tokens.push(parameters);
      if (options.tokenError) throw options.tokenError;
      return { data: 'ExponentPushToken[notification-test]' };
    },
  };
  const constants = options.constants || {
    executionEnvironment: 'standalone',
    expoConfig: { extra: { eas: { projectId: 'test-project-id' } } },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    console: { warn: (...args) => calls.warnings.push(args) },
    require(name) {
      if (name === 'react-native') {
        return { Platform: { OS: options.platform || 'android' }, Alert: { alert: (...args) => calls.alerts.push(args) } };
      }
      if (name === 'expo') return { isRunningInExpoGo: () => Boolean(options.expoGo) };
      if (name === 'expo-constants') return constants;
      if (name === 'expo-notifications') {
        calls.imports += 1;
        if (options.importError) throw options.importError;
        return notifications;
      }
      throw new Error(`Unexpected import: ${name}`);
    },
  }, { filename });
  return { register: module.exports.registerForPushNotificationsAsync, calls };
}

test('importing the notification helper never initializes the native push package', () => {
  const { calls } = notificationHarness({ importError: new Error('native push is unavailable') });
  assert.equal(calls.imports, 0);
  assert.equal(calls.handlers.length, 0);
  assert.equal(calls.permissions, 0);
});

test('Android Expo Go skips push loading and permission requests', async () => {
  const { register, calls } = notificationHarness({ expoGo: true, importError: new Error('Android push was removed from Expo Go') });
  assert.equal(await register(), null);
  assert.equal(calls.imports, 0);
  assert.equal(calls.permissions, 0);
  assert.equal(calls.requests, 0);
  assert.equal(calls.alerts.length, 0);
  assert.equal(calls.warnings.length, 0);
});

test('web skips the native notification package even with an EAS project', async () => {
  const { register, calls } = notificationHarness({ platform: 'web', importError: new Error('native package cannot load on web') });
  assert.equal(await register(), null);
  assert.equal(calls.imports, 0);
  assert.equal(calls.requests, 0);
});

test('storeClient runtime skips push when the Expo Go helper does not identify the client', async () => {
  const { register, calls } = notificationHarness({
    constants: { executionEnvironment: 'storeClient', easConfig: { projectId: 'test-project-id' } },
    importError: new Error('store client push is unavailable'),
  });
  assert.equal(await register(), null);
  assert.equal(calls.imports, 0);
  assert.equal(calls.permissions, 0);
});

test('a native build without an EAS project skips push initialization', async () => {
  const { register, calls } = notificationHarness({ constants: { executionEnvironment: 'standalone' } });
  assert.equal(await register(), null);
  assert.equal(calls.imports, 0);
  assert.equal(calls.permissions, 0);
  assert.equal(calls.requests, 0);
});

test('a supported Android build configures foreground presentation, channel and push token', async () => {
  const { register, calls } = notificationHarness();
  assert.equal(await register(), 'ExponentPushToken[notification-test]');
  assert.equal(calls.imports, 1);
  assert.equal(calls.handlers.length, 1);
  const presentation = await calls.handlers[0].handleNotification();
  assert.equal(presentation.shouldShowBanner, true);
  assert.equal(presentation.shouldShowList, true);
  assert.equal(presentation.shouldPlaySound, true);
  assert.equal(presentation.shouldSetBadge, true);
  assert.equal(calls.channels.length, 1);
  assert.equal(calls.channels[0][0], 'default');
  assert.equal(calls.channels[0][1].importance, 4);
  assert.equal(calls.permissions, 1);
  assert.equal(calls.requests, 0);
  assert.equal(calls.tokens[0].projectId, 'test-project-id');
  assert.equal(calls.warnings.length, 0);
});

test('a supported iOS build uses the EAS project fallback and requests permission when needed', async () => {
  const { register, calls } = notificationHarness({
    platform: 'ios',
    permission: 'undetermined',
    constants: { executionEnvironment: 'standalone', easConfig: { projectId: 'fallback-project' } },
  });
  assert.equal(await register(), 'ExponentPushToken[notification-test]');
  assert.equal(calls.imports, 1);
  assert.equal(calls.channels.length, 0);
  assert.equal(calls.requests, 1);
  assert.equal(calls.tokens[0].projectId, 'fallback-project');
});

test('denied push permission does not request a token', async () => {
  const { register, calls } = notificationHarness({ permission: 'denied', requestedPermission: 'denied' });
  assert.equal(await register(), null);
  assert.equal(calls.requests, 1);
  assert.equal(calls.tokens.length, 0);
  assert.equal(calls.alerts.length, 1);
});

test('native notification import failures are reported without breaking app startup', async () => {
  const { register, calls } = notificationHarness({ importError: new Error('native module is missing') });
  assert.equal(calls.imports, 0);
  assert.equal(await register(), null);
  assert.equal(calls.imports, 1);
  assert.equal(calls.permissions, 0);
  assert.equal(calls.warnings.length, 1);
  assert.ok(calls.warnings[0].some((item) => String(item).includes('native module is missing')));
});

test('push registration network failures return null and preserve a working app', async () => {
  const { register, calls } = notificationHarness({ tokenError: new Error('push service offline') });
  assert.equal(await register(), null);
  assert.equal(calls.tokens.length, 1);
  assert.equal(calls.warnings.length, 1);
  assert.ok(calls.warnings[0].some((item) => String(item).includes('push service offline')));
});

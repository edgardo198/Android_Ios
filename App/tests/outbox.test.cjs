const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const babel = require('@babel/core');

const filename = path.join(__dirname, '../src/core/outbox.js');
const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
  filename, babelrc: false, configFile: false,
  plugins: [require('@babel/plugin-transform-modules-commonjs')],
});

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(options = {}) {
  const values = options.values || new Map();
  const writes = [];
  const storage = {
    async getItem(key) { return values.get(key) || null; },
    async setItem(key, value) {
      await options.beforeWrite?.(key, value);
      writes.push({ key, value });
      values.set(key, value);
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(id) {
      if (id === '@react-native-async-storage/async-storage') return storage;
      if (id === 'expo-crypto') return { randomUUID };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  }, { filename });
  return { ...module.exports, values, writes };
}

test('the queue generates secure UUIDs and trims text without merging intentionally identical messages', async () => {
  const box = harness();
  const first = box.createPendingMessage('1', '  hola  ');
  const second = box.createPendingMessage(1, 'hola');
  assert.match(first.clientId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.notEqual(first.clientId, second.clientId);
  await box.enqueueMessage('me', first);
  await box.enqueueMessage('me', second);
  const restored = await box.loadOutbox('me');
  assert.deepEqual(Array.from(restored, (message) => message.text), ['hola', 'hola']);
  assert.equal(restored[0].connectionId, 1);
});

test('accounts with different username casing have independent durable queues', async () => {
  const box = harness();
  await box.enqueueMessage('Me', box.createPendingMessage(1, 'privado A'));
  await box.enqueueMessage('me', box.createPendingMessage(2, 'privado B'));
  assert.equal((await box.loadOutbox('Me'))[0].text, 'privado A');
  assert.equal((await box.loadOutbox('me'))[0].text, 'privado B');
  assert.equal((await box.loadOutbox('another')).length, 0);
});

test('history revisions survive restoration and queues saved by an older app default to the initial revision', async () => {
  const box = harness();
  const fresh = box.createPendingMessage(1, 'después del borrado', 3);
  await box.enqueueMessage('me', fresh);
  assert.equal((await harness({ values: box.values }).loadOutbox('me'))[0].historyRevision, 3);
  const legacy = { ...fresh }; delete legacy.historyRevision;
  box.values.set('chat.outbox.v1:legacy', JSON.stringify({ version: 1, messages: [legacy] }));
  assert.equal((await box.loadOutbox('legacy'))[0].historyRevision, 0);
  await assert.rejects(box.enqueueMessage('invalid', { ...fresh, historyRevision: -1 }));
});

test('serialized concurrent appends cannot overwrite each other and restoration waits for a pending disk write', async () => {
  const gate = deferred();
  let blocked = true;
  const box = harness({ beforeWrite: async () => { if (blocked) { blocked = false; await gate.promise; } } });
  const first = box.enqueueMessage('me', box.createPendingMessage(1, 'primero'));
  const second = box.enqueueMessage('me', box.createPendingMessage(1, 'segundo'));
  let loaded = false;
  const restoring = box.loadOutbox('me').then((queue) => { loaded = true; return queue; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaded, false);
  assert.equal(box.writes.length, 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(Array.from(await restoring, (message) => message.text), ['primero', 'segundo']);
});

test('a restarted app retries an interrupted send but retains a known failed delivery for manual retry', async () => {
  const box = harness();
  const first = box.createPendingMessage(1, 'en vuelo');
  const second = box.createPendingMessage(1, 'rechazado');
  await box.updateOutbox('me', () => [
    { ...first, deliveryStatus: 'sending' },
    { ...second, deliveryStatus: 'failed', deliveryError: 'No tienes permiso.' },
  ]);
  const restarted = harness({ values: box.values });
  const queue = await restarted.loadOutbox('me');
  assert.equal(queue[0].deliveryStatus, 'pending');
  assert.equal(queue[0].clientId, first.clientId);
  assert.equal(queue[1].deliveryStatus, 'failed');
  assert.equal(queue[1].deliveryError, 'No tienes permiso.');
});

test('a full queue rejects new messages without silently evicting unsent text', async () => {
  const box = harness();
  const pending = Array.from({ length: box.OUTBOX_LIMIT }, (_, index) => box.createPendingMessage(1, `mensaje ${index}`));
  await box.updateOutbox('me', () => pending);
  await assert.rejects(box.enqueueMessage('me', box.createPendingMessage(1, 'extra')), /100 mensajes pendientes/);
  const restored = await box.loadOutbox('me');
  assert.equal(restored.length, box.OUTBOX_LIMIT);
  assert.equal(restored[0].text, 'mensaje 0');
  assert.equal(restored.at(-1).text, 'mensaje 99');
});

test('storage failure rejects acceptance and a later retry can save the same message', async () => {
  let fail = true;
  const box = harness({ beforeWrite: () => { if (fail) throw new Error('disco lleno'); } });
  const message = box.createPendingMessage(1, 'no perder');
  await assert.rejects(box.enqueueMessage('me', message), /disco lleno/);
  assert.equal(box.values.size, 0);
  fail = false;
  await box.enqueueMessage('me', message);
  assert.equal((await box.loadOutbox('me'))[0].clientId, message.clientId);
});

test('queued mutations stop after an account change before touching that account storage', async () => {
  const gate = deferred();
  const box = harness({ beforeWrite: () => gate.promise });
  const first = box.enqueueMessage('me', box.createPendingMessage(1, 'ya guardándose'));
  let active = true;
  const stale = box.enqueueMessage('me', box.createPendingMessage(1, 'sesión anterior'), () => active);
  const rejected = assert.rejects(stale, { code: 'SESSION_CHANGED' });
  await new Promise((resolve) => setImmediate(resolve));
  active = false;
  gate.resolve();
  await first;
  await rejected;
  assert.equal(box.writes.length, 1);
  assert.equal((await box.loadOutbox('me')).length, 1);
});

test('an unreadable persisted queue is reported and cannot be overwritten by a new send', async () => {
  const values = new Map([['chat.outbox.v1:me', '{broken']]);
  const box = harness({ values });
  await assert.rejects(box.loadOutbox('me'), /leer la cola/);
  await assert.rejects(box.enqueueMessage('me', box.createPendingMessage(1, 'nuevo')), /leer la cola/);
  assert.equal(values.get('chat.outbox.v1:me'), '{broken');
  assert.equal(box.writes.length, 0);
});

test('invalid destinations and overlong text cannot enter durable storage', () => {
  const box = harness();
  for (const connectionId of [0, -1, 1.5, 'alice']) assert.throws(() => box.createPendingMessage(connectionId, 'hola'), /inválido/);
  assert.throws(() => box.createPendingMessage(1, ' '), /inválido/);
  assert.throws(() => box.createPendingMessage(1, 'x'.repeat(box.TEXT_MESSAGE_LIMIT + 1)), /inválido/);
  assert.equal(box.values.size, 0);
});

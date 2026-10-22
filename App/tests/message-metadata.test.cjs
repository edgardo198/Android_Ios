const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

const react = {
  memo: component => component,
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: value => [value, () => {}],
  useRef: value => ({ current: value }),
  useEffect() {},
};
function load(file, extra = {}) {
  const filename = path.join(__dirname, '..', 'src', 'components', 'Message', file);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }],
      require('@babel/plugin-transform-modules-commonjs')],
  });
  const mocks = { react, 'react-native': { View: 'View', Text: 'Text', TouchableOpacity: 'Button', ActivityIndicator: 'Spinner' },
    '../../Styles/messageStyles': {}, ...extra };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Date,
    require(name) { if (!(name in mocks)) throw new Error(`Missing mock: ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
const metadata = load('MessageMetadata.js');

test('time uses the timestamp in device local time, never an invented current time', () => {
  const created = '2026-10-07T12:07:00Z';
  const date = new Date(created);
  const expected = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  assert.equal(metadata.messageTime(created), expected);
  for (const invalid of [undefined, null, '', '  ', 'invalid-date', 0, false]) assert.equal(metadata.messageTime(invalid), null);
});

test('only a confirmed own message with an explicit read receipt says Leído', () => {
  const message = { id: 42, isNew: true };
  assert.equal(metadata.messageReceipt(message, true), 'Enviado');
  assert.equal(metadata.messageReceipt({ ...message, isNew: false }, true), 'Leído');
  assert.equal(metadata.messageReceipt({ id: 42 }, true), 'Enviado');
  assert.equal(metadata.messageReceipt({ ...message, isNew: 0 }, true), 'Enviado');
  assert.equal(metadata.messageReceipt({ ...message, isNew: false }, false), null);
});

test('pending sending and failed messages never claim delivery or reading', () => {
  for (const deliveryStatus of ['pending', 'sending', 'failed']) {
    assert.equal(metadata.messageReceipt({ id: 42, isNew: false, deliveryStatus }, true), null);
  }
  for (const id of [undefined, null, 0, 'local-id']) assert.equal(metadata.messageReceipt({ id, isNew: false }, true), null);
});

test('read status is accessible and updates independently of message content type', () => {
  for (const type of ['text', 'image', 'audio', 'video', 'document']) {
    const tree = metadata.default({ message: { id: 42, type, created: 'invalid', isNew: false }, sentByMe: true });
    const receipt = nodes(tree, node => node.props.accessibilityLabel === 'Estado del mensaje: Leído')[0];
    assert.ok(receipt, type);
    assert.equal(receipt.props.accessibilityLiveRegion, 'polite');
    assert.equal(nodes(tree, node => node.props.accessibilityLabel?.startsWith('Hora del mensaje')).length, 0);
  }
  assert.equal(metadata.default({ message: {}, sentByMe: false }), null);
});

test('both bubble variants include metadata but the typing indicator does not', () => {
  const mocks = { './MessageContent': 'Content', './MessageMetadata': 'Metadata',
    '../../common/Miniatura': 'Avatar', './MessageTypingAnimation': 'Typing' };
  const me = load('MessageBubbleMe.js', mocks).default({ message: { id: 42, type: 'audio', audio: 'file://audio' } });
  assert.equal(nodes(me, node => node.type === 'Metadata')[0].props.sentByMe, true);
  const friend = load('MessageBubbleFriend.js', mocks).default;
  assert.equal(nodes(friend({ message: { id: 42 }, friend: {} }), node => node.type === 'Metadata').length, 1);
  assert.equal(nodes(friend({ typing: true, friend: {} }), node => node.type === 'Metadata').length, 0);
});

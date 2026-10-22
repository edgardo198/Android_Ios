const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');

function load(relative, mocks) {
  const filename = path.join(__dirname, '..', relative);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }], '@babel/plugin-transform-modules-commonjs'],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) { if (!(name in mocks)) throw new Error(`Missing mock: ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports.default;
}
const nodes = (tree, predicate) => Array.isArray(tree) ? tree.flatMap((item) => nodes(item, predicate))
  : !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
const element = (type, attributes, ...children) => ({ type, props: { ...attributes, children } });

test('full screen GIF playback is unmounted when closed and never caches a private signed source', () => {
  const viewer = load('src/components/Message/GifViewer.js', {
    react: { createElement: element },
    'react-native': { Modal: 'Modal', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View', StyleSheet: { create: (style) => style } },
    'expo-image': { Image: 'ExpoImage' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 0 }) },
  });
  let closed = 0;
  const props = { uri: 'http://127.0.0.1:8030/chat/messages/1/media/image/?ticket=synthetic', visible: false,
    onRequestClose: () => { closed += 1; } };
  assert.equal(viewer(props), null);
  const tree = viewer({ ...props, visible: true });
  const image = nodes(tree, (node) => node.type === 'ExpoImage')[0];
  assert.equal(image.props.source.uri, props.uri);
  assert.equal(image.props.source.isAnimated, true);
  assert.equal(image.props.autoplay, true);
  assert.equal(image.props.cachePolicy, 'none');
  assert.equal(image.props.contentFit, 'contain');
  nodes(tree, (node) => node.props.accessibilityLabel === 'Cerrar GIF')[0].props.onPress();
  assert.equal(closed, 1);
  assert.equal(viewer({ ...props, visible: false }), null);
});

test('a GIF message renders only its authorized source and opens the animated viewer with a refreshed private ticket', async () => {
  const values = [];
  let cursor = 0;
  const react = { createElement: element, memo: (component) => component,
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial;
      return [values[index], (value) => { values[index] = value; }]; },
    useRef(value) { const index = cursor++; if (!(index in values)) values[index] = { current: value }; return values[index]; },
    useEffect() {},
  };
  const stable = '/chat/messages/91/media/image/';
  let source = { uri: null, loading: true, version: 0, isPrivate: true, reload() {} };
  const acquired = [];
  let asserted = 0;
  const message = load('src/components/Message/MessageImage.js', {
    react, 'react-native': { TouchableOpacity: 'TouchableOpacity', View: 'View', ActivityIndicator: 'ActivityIndicator', Text: 'Text',
      Alert: { alert() {} }, StyleSheet: { create: (style) => style, absoluteFill: {} } },
    '@expo/vector-icons': { Ionicons: 'Ionicons' }, 'expo-image': { Image: 'ExpoImage' },
    './ImageViewer': 'ImageViewer', './GifViewer': 'GifViewer',
    './gifFiles': { isGifImage: (name) => /\.gif$/i.test(name) },
    '../../core/usePrivateMediaSource': () => source,
    '../../core/privateMedia': { captureMediaSession: () => ({ assertActive() { asserted += 1; } }),
      isPrivateMediaSource: () => true, async getMediaSource(value) { acquired.push(value); return 'http://127.0.0.1:8030' + stable + '?ticket=fresh'; } },
    './mediaFiles': { async saveMediaToGallery() {} },
  });
  const render = () => { cursor = 0; return message({ message: { image: stable, filename: 'animation.gif' } }); };
  assert.equal(nodes(render(), (node) => node.type === 'ExpoImage').length, 0, 'An unsigned stable URL cannot reach the image');
  source = { ...source, uri: 'http://127.0.0.1:8030' + stable + '?ticket=authorized', loading: false };
  const image = nodes(render(), (node) => node.type === 'ExpoImage')[0];
  assert.equal(image.props.source.uri, source.uri);
  assert.equal(image.props.source.isAnimated, true);
  assert.equal(image.props.autoplay, true);
  assert.equal(image.props.cachePolicy, 'none');
  image.props.onLoad();
  await nodes(render(), (node) => node.props.accessibilityLabel === 'Abrir GIF')[0].props.onPress();
  const viewer = nodes(render(), (node) => node.type === 'GifViewer')[0];
  assert.equal(viewer.props.visible, true);
  assert.equal(viewer.props.uri, 'http://127.0.0.1:8030' + stable + '?ticket=fresh');
  assert.deepEqual(acquired, [stable]);
  assert.equal(asserted, 1);
  assert.equal(nodes(render(), (node) => node.type === 'ImageViewer').length, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

const filename = path.join(__dirname, '../src/components/Message/AttachmentPreview.js');
const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
  filename, configFile: false, babelrc: false,
  plugins: [
    [require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }],
    require('@babel/plugin-transform-modules-commonjs'),
  ],
});

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (tree && typeof tree === 'object') return textContent(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function previewHarness(preview, options = {}) {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let effects = [];
  let props = { preview, onConfirm: options.onConfirm, onCancel: options.onCancel, ...options.props };
  const calls = { keyboardDismisses: 0 };
  const react = {
    memo: (component) => component,
    createElement: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, dependency) => !Object.is(value, previous.dependencies[dependency]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const native = Object.fromEntries(['ActivityIndicator', 'Image', 'Modal', 'ScrollView', 'Text', 'TouchableOpacity', 'View'].map((name) => [name, name]));
  Object.assign(native, {
    Keyboard: { dismiss() { calls.keyboardDismisses += 1; } },
    Platform: { OS: options.platform || 'web', select: (choices) => choices[options.platform || 'web'] },
    useWindowDimensions: () => ({ width: options.width || 390, height: options.height || 844 }),
    StyleSheet: { create: (value) => value },
  });
  const mocks = {
    react, 'react-native': native,
    'expo-image': { Image: 'ExpoImage' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 20 }) },
    '@fortawesome/react-native-fontawesome': { FontAwesomeIcon: 'FontAwesomeIcon' },
    '@fortawesome/free-solid-svg-icons': { faFile: 'file-icon' },
    './AudioPlayer': 'AudioPlayer', './VideoPlayer': 'VideoPlayer',
    './mediaMetadata': { getExtension: (name) => name.split('.').pop() },
    './gifFiles': { isGifImage: (name, mime) => /\.gif$/i.test(name) || mime === 'image/gif' },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) {
      if (!(name in mocks)) throw new Error(`Missing mock: ${name}`);
      return mocks[name];
    },
  }, { filename });
  const render = () => {
    let tree;
    do {
      cursor = 0; dirty = false; effects = [];
      tree = module.exports.default(props);
      effects.forEach((effect) => effect());
    } while (dirty);
    return tree;
  };
  const button = (label) => nodes(render(), (node) => node.props.accessibilityLabel === label)[0];
  render();
  return {
    render, button, calls, formatSize: module.exports.formatAttachmentSize,
    setProps(next) { props = { ...props, ...next }; return render(); },
    closeRequest() { return nodes(render(), (node) => node.type === 'Modal')[0].props.onRequestClose(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

const image = { type: 'image', asset: { uri: 'file:///original-photo.png' }, fileName: 'original-photo.png', size: 2048 };

test('GIF review uses the original animated Expo image with no cache or conversion and waits for send', () => {
  let sends = 0;
  const gif = { type: 'image', asset: { uri: 'blob:original-animation' }, fileName: 'animation.gif', mimeType: 'image/gif', size: 2048 };
  const h = previewHarness(gif, { onConfirm: async () => { sends += 1; } });
  const displayed = nodes(h.render(), (node) => node.type === 'ExpoImage')[0];
  assert.equal(displayed.props.source.uri, gif.asset.uri);
  assert.equal(displayed.props.source.isAnimated, true);
  assert.equal(displayed.props.autoplay, true);
  assert.equal(displayed.props.contentFit, 'contain');
  assert.equal(displayed.props.cachePolicy, 'none');
  assert.equal(nodes(h.render(), (node) => node.type === 'Image').length, 0);
  assert.match(textContent(h.render()), /GIF seleccionado/);
  assert.equal(sends, 0);
  displayed.props.onError();
  assert.match(textContent(h.render()), /No se pudo mostrar el GIF seleccionado/);
});

test('reviewing an image keeps its original URI and never invokes send', () => {
  let sends = 0;
  const h = previewHarness(image, { onConfirm: async () => { sends += 1; } });
  const displayed = nodes(h.render(), (node) => node.type === 'Image')[0];
  assert.equal(displayed.props.source.uri, image.asset.uri);
  assert.equal(displayed.props.resizeMode, 'contain');
  assert.equal(sends, 0);
  assert.equal(h.calls.keyboardDismisses, 1);
  assert.match(textContent(h.render()), /2.0 KB/);
});

test('video and audio use local selected sources with explicit existing player controls', () => {
  const video = previewHarness({ type: 'video', asset: { uri: 'content://selected-video' }, fileName: 'video.mp4' });
  const player = nodes(video.render(), (node) => node.type === 'VideoPlayer')[0];
  assert.equal(player.props.source.uri, 'content://selected-video');
  assert.equal(player.props.resizeMode, 'contain');
  assert.equal(player.props.useNativeControls, true);
  const audio = previewHarness({ type: 'audio', asset: { uri: 'file:///recording.m4a' }, fileName: 'recording.m4a' });
  assert.equal(nodes(audio.render(), (node) => node.type === 'AudioPlayer')[0].props.audioUri, 'file:///recording.m4a');
  audio.setProps({ preview: null });
  assert.equal(audio.render(), null);
});

test('document review shows metadata without invoking an external viewer', () => {
  const fileName = `${'very-long-name-'.repeat(30)}.pdf`;
  const h = previewHarness({ type: 'document', asset: { uri: 'blob:document', file: { size: 1048576 } }, fileName });
  assert.match(textContent(h.render()), /Documento seleccionado/);
  assert.match(textContent(h.render()), /PDF · 1.0 MB/);
  const fileLabel = nodes(h.render(), (node) => node.props.accessibilityLabel === `Archivo seleccionado: ${fileName}`)[0];
  assert.equal(fileLabel.props.numberOfLines, 3);
  assert.equal(nodes(h.render(), (node) => ['AudioPlayer', 'VideoPlayer', 'Image'].includes(node.type)).length, 0);
});

test('send guards repeated taps and cancellation immediately, before uploading props arrive', async () => {
  const upload = deferred();
  let sends = 0;
  let cancels = 0;
  const h = previewHarness(image, {
    onConfirm: async () => { sends += 1; await upload.promise; },
    onCancel: () => { cancels += 1; },
  });
  const send = h.button('Enviar archivo').props.onPress;
  const cancel = h.button('Cancelar vista previa').props.onPress;
  const sending = send();
  await send();
  cancel();
  h.closeRequest();
  assert.equal(sends, 1);
  assert.equal(cancels, 0);
  assert.equal(h.button('Enviando archivo').props.disabled, true);
  assert.equal(h.button('Cancelar vista previa').props.disabled, true);
  upload.resolve();
  await sending;
  assert.equal(h.button('Enviar archivo').props.disabled, false);
});

test('uploading unmounts playback and both Escape and Android back cannot close the preview', () => {
  for (const platform of ['web', 'android']) {
    let cancels = 0;
    const h = previewHarness({ type: 'audio', asset: { uri: 'file:///recording.m4a' }, fileName: 'audio.m4a' }, {
      platform, onConfirm: async () => true, onCancel: () => { cancels += 1; }, props: { isUploading: true },
    });
    assert.equal(nodes(h.render(), (node) => node.type === 'AudioPlayer').length, 0);
    h.closeRequest();
    assert.equal(cancels, 0);
    h.setProps({ isUploading: false });
    assert.equal(nodes(h.render(), (node) => node.type === 'AudioPlayer').length, 1);
    h.closeRequest();
    assert.equal(cancels, 1);
  }
});

test('failed send keeps the selected source, exposes an inline error and permits retry', async () => {
  let sends = 0;
  const h = previewHarness(image, { onConfirm: async () => {
    sends += 1;
    if (sends === 1) throw new Error('offline');
  } });
  await h.button('Enviar archivo').props.onPress();
  assert.match(textContent(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert')[0]), /Verifica tu conexión/);
  assert.equal(nodes(h.render(), (node) => node.type === 'Image')[0].props.source.uri, image.asset.uri);
  await h.button('Enviar archivo').props.onPress();
  assert.equal(sends, 2);
  h.setProps({ previewError: 'El archivo supera el tamaño permitido.' });
  assert.match(textContent(h.render()), /supera el tamaño/);
});

test('small viewport gives the scroll area bounded space and keeps fixed footer controls', () => {
  const h = previewHarness(image, { width: 320, height: 320 });
  const card = nodes(h.render(), (node) => node.props.accessibilityViewIsModal)[0];
  assert.equal(card.props.style[1].maxHeight, 244);
  const scroll = nodes(h.render(), (node) => node.type === 'ScrollView')[0];
  assert.equal(scroll.props.style.flexShrink, 1);
  assert.equal(scroll.props.style.minHeight, 0);
  assert.ok(h.button('Enviar archivo'));
  assert.ok(h.button('Cancelar vista previa'));
});

test('sizes display bytes and units while unavailable metadata stays explicit', () => {
  const h = previewHarness(image);
  assert.equal(h.formatSize(undefined), 'Tamaño no disponible');
  assert.equal(h.formatSize(-1), 'Tamaño no disponible');
  assert.equal(h.formatSize(Infinity), 'Tamaño no disponible');
  assert.equal(h.formatSize(0), '0 B');
  assert.equal(h.formatSize(1024), '1.0 KB');
  assert.equal(h.formatSize(1048576), '1.0 MB');
});

test('known upload progress exposes real bytes to assistive technology and stopping guards repeated taps', () => {
  let stops = 0;
  let closes = 0;
  const h = previewHarness(image, {
    onConfirm: async () => true,
    onCancel: () => { closes += 1; },
    props: {
      isUploading: true,
      uploadProgress: { phase: 'uploading', loaded: 512, total: 2048, percent: 25 },
      onCancelUpload: () => { stops += 1; return true; },
    },
  });
  const bar = nodes(h.render(), (node) => node.props.accessibilityRole === 'progressbar')[0];
  assert.equal(bar.props.accessibilityValue.now, 25);
  assert.equal(bar.props['aria-valuenow'], 25);
  assert.equal(bar.props['aria-busy'], true);
  assert.match(textContent(h.render()), /25%/);
  assert.match(textContent(h.render()), /512 B de 2.0 KB/);
  const stop = h.button('Detener subida').props.onPress;
  stop();
  stop();
  h.closeRequest();
  assert.equal(stops, 1);
  assert.equal(closes, 0);
  assert.equal(h.button('Detener subida').props.disabled, true);
});

test('all uploaded bytes display pending server confirmation and still cannot send again', () => {
  const h = previewHarness(image, {
    onConfirm: async () => true,
    props: {
      isUploading: true,
      uploadProgress: { phase: 'processing', loaded: 2048, total: 2048, percent: 100 },
      onCancelUpload: () => true,
    },
  });
  const bar = nodes(h.render(), (node) => node.props.accessibilityRole === 'progressbar')[0];
  assert.equal(bar.props.accessibilityValue.now, 100);
  assert.match(bar.props.accessibilityValue.text, /Esperando confirmación del servidor/);
  assert.doesNotMatch(textContent(h.render()), /Archivo confirmado/);
  assert.equal(h.button('Enviando archivo').props.disabled, true);
  assert.equal(h.button('Detener subida').props.disabled, false);
});

test('unknown totals remain indeterminate and a stopped upload preserves the selection for manual review', () => {
  const h = previewHarness(image, {
    onConfirm: async () => true,
    onCancel: () => true,
    props: {
      isUploading: true,
      uploadProgress: { phase: 'uploading', loaded: 12345, total: null },
      onCancelUpload: () => true,
    },
  });
  const bar = nodes(h.render(), (node) => node.props.accessibilityRole === 'progressbar')[0];
  assert.equal(bar.props.accessibilityValue.now, undefined);
  assert.equal(bar.props['aria-valuenow'], undefined);
  assert.match(textContent(h.render()), /12.1 KB enviados/);
  assert.match(textContent(h.render()), /total no disponible/);
  assert.doesNotMatch(textContent(h.render()), /\d+%/);
  assert.equal(nodes(bar, (node) => node.type === 'ActivityIndicator').length, 1);
  h.setProps({
    isUploading: false,
    uploadProgress: { phase: 'cancelled', loaded: 12345, total: null },
    previewError: 'Si el archivo ya llegó al servidor, puede aparecer en el chat. Revisa antes de reintentar.',
  });
  assert.equal(nodes(h.render(), (node) => node.type === 'Image')[0].props.source.uri, image.asset.uri);
  assert.match(textContent(nodes(h.render(), (node) => node.props.accessibilityRole === 'alert')[0]), /Revisa antes de reintentar/);
  assert.equal(h.button('Enviar archivo').props.disabled, false);
  assert.equal(h.button('Cancelar vista previa').props.disabled, false);
});

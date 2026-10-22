const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

function harness(initial) {
  let media = initial;
  const constructed = [];
  const player = { status: 'readyToPlay', loop: false, play() { throw new Error('Playback must require user action'); },
    replaceAsync() { throw new Error('Web replacement would autoplay'); } };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useEffect: effect => effect(),
  };
  const mocks = { react,
    'react-native': { View: 'View', Text: 'Text', TouchableOpacity: 'Button', ActivityIndicator: 'Loading',
      StyleSheet: { create: value => value, absoluteFill: {}, absoluteFillObject: {} } },
    expo: { useEvent: () => ({ status: player.status }) },
    'expo-video': { VideoView: 'VideoView', useVideoPlayer(source) { constructed.push(source); return player; } },
    '../../core/usePrivateMediaSource': () => media,
    './usePlaybackLifecycle': () => {},
  };
  const filename = path.join(__dirname, '../src/components/Message/VideoPlayer.js');
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [[require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }], require('@babel/plugin-transform-modules-commonjs')],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require(name) { if (!(name in mocks)) throw new Error(`Missing mock ${name}`); return mocks[name]; },
  }, { filename });
  return { constructed, player,
    setMedia(next) { media = next; },
    render() { return module.exports.default({ source: '/chat/messages/42/media/video/', isLooping: false, useNativeControls: true }); },
  };
}
function playback(tree) { return tree.props.children.find(node => node && typeof node.type === 'function' && node.props.media?.uri); }

test('private and local videos construct paused players without using the autoplaying replacement API', () => {
  for (const isPrivate of [true, false]) {
    const uri = isPrivate ? 'https://api.test/chat/messages/42/media/video/?ticket=test' : 'blob:local-preview';
    const h = harness({ uri, isPrivate, version: 1 });
    const child = playback(h.render());
    assert.ok(child);
    child.type(child.props);
    assert.equal(h.constructed.length, 1);
    assert.equal(h.constructed[0].uri, uri);
    assert.equal(h.constructed[0].useCaching, !isPrivate);
    assert.equal(h.player.loop, false);
  }
});

test('renewing the same video URL changes its React key so a failed player is released and retried', () => {
  const media = { uri: 'https://api.test/video/?ticket=test', isPrivate: true, version: 1 };
  const h = harness(media);
  const first = playback(h.render());
  h.setMedia({ ...media, version: 2 });
  const retry = playback(h.render());
  assert.notEqual(first.props.key, retry.props.key);
  h.setMedia({ ...media, uri: null, loading: true });
  assert.equal(playback(h.render()), undefined, 'No old player remains visible while another account acquires access');
});

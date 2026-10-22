const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');

const filename = path.join(__dirname, '../src/components/Message/AudioPlayer.js');
const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
  filename,
  configFile: false,
  babelrc: false,
  plugins: [
    [require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }],
    require('@babel/plugin-transform-modules-commonjs'),
  ],
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function findNodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((node) => findNodes(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...findNodes(tree.props?.children, predicate)];
}

function textContent(tree) {
  if (Array.isArray(tree)) return tree.map(textContent).join('');
  if (tree && typeof tree === 'object') return textContent(tree.props?.children);
  return tree == null || typeof tree === 'boolean' ? '' : String(tree);
}

function audioHarness(options = {}) {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let effects = [];
  let status = {
    currentTime: 10,
    duration: 120,
    isLoaded: true,
    playing: false,
    didJustFinish: false,
    isBuffering: false,
    error: null,
    ...options.status,
  };
  const calls = { plays: 0, pauses: 0, seeks: [], replacements: [], modes: [], events: [] };
  const playbackSession = { current: { active: true, generation: 1 } };
  const player = {
    play() {
      calls.plays += 1;
      calls.events.push('play');
      if (options.playError?.(calls.plays)) throw new Error('native playback failed');
      status = { ...status, playing: true, didJustFinish: false };
    },
    pause() {
      calls.pauses += 1;
      calls.events.push('pause');
      status = { ...status, playing: false };
    },
    async seekTo(seconds) {
      calls.seeks.push(seconds);
      calls.events.push(`seek:${seconds}`);
      if (options.seek) await options.seek(seconds);
      status = { ...status, currentTime: seconds };
    },
    replace(source) {
      calls.replacements.push(source);
      calls.events.push('replace');
      status = { ...status, error: null, currentTime: 0, playing: false, isLoaded: false, didJustFinish: false };
    },
  };
  const react = {
    memo: (component) => component,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
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
      if (!previous || !dependencies || dependencies.some((value, dependency) => !Object.is(value, previous.dependencies[dependency]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require(name) {
      const mocks = {
        react,
        'react-native': { Platform: { OS: options.platform || 'android' }, View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator' },
        '@react-native-community/slider': 'Slider',
        '@fortawesome/react-native-fontawesome': { FontAwesomeIcon: 'FontAwesomeIcon' },
        '@fortawesome/free-solid-svg-icons': { faPlay: 'play', faPause: 'pause', faRotateRight: 'retry' },
        'expo-audio': {
          useAudioPlayer: () => player,
          useAudioPlayerStatus: () => status,
          async setAudioModeAsync(mode) {
            calls.modes.push(mode);
            calls.events.push('mode');
            if (options.mode) await options.mode();
          },
        },
        '../../core/api': { resolveMediaUrl: (value) => value },
        '../../core/usePrivateMediaSource': () => ({ uri: options.uri || 'https://chat.test/media/audio.m4a', loading: false, error: null, isPrivate: false, version: 0 }),
        './usePlaybackLifecycle': () => playbackSession,
        '../../Styles/audioStyles': {},
      };
      if (name in mocks) return mocks[name];
      throw new Error(`Unexpected import: ${name}`);
    },
  }, { filename });
  const Component = module.exports.default;
  function render() {
    let tree;
    let attempts = 0;
    do {
      assert.ok(attempts++ < 10, 'Unexpected render loop');
      dirty = false;
      cursor = 0;
      effects = [];
      tree = Component({ audioUri: options.uri || 'https://chat.test/media/audio.m4a' });
      effects.forEach((effect) => effect());
    } while (dirty);
    return tree;
  }
  function find(type) {
    const nodes = findNodes(render(), (node) => node.type === type);
    assert.equal(nodes.length, 1, `Missing ${type}`);
    return nodes[0];
  }
  return {
    calls,
    render,
    setStatus(update) { status = { ...status, ...update }; },
    button: () => find('TouchableOpacity'),
    slider: () => find('Slider'),
    progress: () => {
      const nodes = findNodes(render(), (node) => node.props.accessibilityRole === 'adjustable');
      assert.equal(nodes.length, 1);
      return nodes[0];
    },
    text: () => findNodes(render(), (node) => node.type === 'Text').map(textContent),
    alert: () => findNodes(render(), (node) => node.type === 'Text' && node.props.accessibilityRole === 'alert').map(textContent).join(''),
    press: () => find('TouchableOpacity').props.onPress(),
    leave() {
      playbackSession.current.active = false;
      playbackSession.current.generation += 1;
      player.pause();
    },
    refocus() {
      playbackSession.current.active = true;
      playbackSession.current.generation += 1;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('dragging previews real audio times and seeks once only after the thumb is released', async () => {
  const pendingSeek = deferred();
  const audio = audioHarness({ status: { duration: 145 }, seek: () => pendingSeek.promise });
  assert.equal(audio.slider().props.value, 10);
  assert.ok(audio.text().includes('0:10'));
  assert.ok(audio.text().includes('2:25'));
  audio.slider().props.onSlidingStart();
  audio.slider().props.onValueChange(45.9);
  audio.setStatus({ currentTime: 11 });
  assert.equal(audio.slider().props.value, 45.9);
  assert.equal(audio.progress().props.accessibilityValue.text, '0:45 de 2:25');
  assert.equal(audio.calls.seeks.length, 0);
  const seeking = audio.slider().props.onSlidingComplete(45.9);
  assert.deepEqual(audio.calls.seeks, [45.9]);
  assert.equal(audio.slider().props.disabled, true);
  await audio.slider().props.onSlidingComplete(80);
  assert.equal(audio.calls.seeks.length, 1);
  pendingSeek.resolve();
  await seeking;
  assert.equal(audio.slider().props.value, 45.9);
  assert.equal(audio.slider().props.disabled, false);
});

test('play and pause follow native playback status without resetting an unfinished recording', async () => {
  const audio = audioHarness();
  assert.equal(audio.button().props.accessibilityLabel, 'Reproducir audio');
  await audio.press();
  assert.equal(audio.calls.plays, 1);
  assert.equal(audio.calls.modes.length, 1);
  assert.equal(audio.calls.seeks.length, 0);
  assert.equal(audio.button().props.accessibilityLabel, 'Pausar audio');
  await audio.press();
  assert.equal(audio.calls.pauses, 1);
  assert.equal(audio.calls.plays, 1);
  assert.equal(audio.button().props.accessibilityLabel, 'Reproducir audio');
});

test('replay waits for seeking to zero before playing and ignores concurrent taps', async () => {
  const pendingSeek = deferred();
  const audio = audioHarness({
    status: { duration: 30, currentTime: 30, didJustFinish: true },
    seek: () => pendingSeek.promise,
  });
  const replaying = audio.press();
  await flush();
  assert.deepEqual(audio.calls.seeks, [0]);
  assert.equal(audio.calls.plays, 0);
  assert.equal(audio.button().props.disabled, true);
  await audio.press();
  assert.equal(audio.calls.seeks.length, 1);
  pendingSeek.resolve();
  await replaying;
  assert.deepEqual(audio.calls.events, ['mode', 'seek:0', 'play']);
  assert.equal(audio.button().props.disabled, false);
});

test('a playback failure offers retry which replaces the source before normal playback resumes', async () => {
  const audio = audioHarness({ playError: (attempt) => attempt === 1 });
  await audio.press();
  assert.equal(audio.button().props.accessibilityLabel, 'Reintentar audio');
  assert.notEqual(audio.alert(), '');
  await audio.press();
  assert.equal(audio.calls.replacements.length, 1);
  assert.equal(audio.calls.replacements[0].uri, 'https://chat.test/media/audio.m4a');
  assert.equal(audio.calls.plays, 1);
  assert.equal(audio.alert(), '');
  assert.equal(audio.button().props.disabled, true);
  audio.setStatus({ isLoaded: true });
  await audio.press();
  assert.equal(audio.calls.plays, 2);
  assert.equal(audio.button().props.accessibilityLabel, 'Pausar audio');
});

test('native loading and seek errors expose a retry instead of leaving the controls busy', async () => {
  const audio = audioHarness({ seek: async () => { throw new Error('seek failed'); } });
  await audio.slider().props.onSlidingComplete(35);
  assert.equal(audio.button().props.accessibilityLabel, 'Reintentar audio');
  assert.equal(audio.button().props.disabled, false);
  assert.notEqual(audio.alert(), '');
  await audio.press();
  assert.equal(audio.calls.replacements.length, 1);
  assert.equal(audio.alert(), '');
  audio.setStatus({ error: 'remote file not found', isLoaded: false });
  assert.equal(audio.button().props.accessibilityLabel, 'Reintentar audio');
  assert.equal(audio.button().props.disabled, false);
});

test('seek release and accessibility actions stay within the loaded audio duration', async () => {
  const audio = audioHarness({ status: { currentTime: 8, duration: 30 } });
  await audio.slider().props.onSlidingComplete(-40);
  await audio.slider().props.onSlidingComplete(300);
  assert.deepEqual(audio.calls.seeks, [0, 30]);
  audio.setStatus({ currentTime: 8 });
  audio.progress().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
  await flush();
  audio.progress().props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } });
  await flush();
  assert.deepEqual(audio.calls.seeks, [0, 30, 13, 8]);
});

test('web keyboard seeks by five seconds with Home and End shortcuts and preserves unrelated keys', async () => {
  const audio = audioHarness({ platform: 'web', status: { currentTime: 28, duration: 30 } });
  let prevented = 0;
  const key = async (value) => {
    audio.progress().props.onKeyDown({ key: value, preventDefault() { prevented += 1; } });
    await flush();
  };
  await key('ArrowRight');
  await key('Home');
  await key('ArrowLeft');
  await key('End');
  await key('PageDown');
  assert.deepEqual(audio.calls.seeks, [30, 0, 0, 30]);
  assert.equal(prevented, 4);
});

test('Android buffering keeps pause available even though the player is temporarily not loaded', async () => {
  const audio = audioHarness({ status: { isLoaded: false, isBuffering: true, playing: true } });
  assert.equal(audio.button().props.accessibilityLabel, 'Pausar audio');
  assert.equal(audio.button().props.disabled, false);
  assert.equal(audio.slider().props.disabled, true);
  await audio.press();
  assert.equal(audio.calls.pauses, 1);
  assert.equal(audio.calls.plays, 0);
  assert.equal(audio.calls.modes.length, 0);
});

test('leaving the conversation cancels delayed playback even when focus returns before audio mode resolves', async () => {
  for (const refocus of [false, true]) {
    const mode = deferred();
    const audio = audioHarness({ mode: () => mode.promise });
    const playing = audio.press();
    assert.equal(audio.calls.modes.length, 1);
    assert.equal(audio.calls.plays, 0);
    audio.leave();
    if (refocus) audio.refocus();
    mode.resolve();
    await playing;
    assert.equal(audio.calls.plays, 0);
    assert.equal(audio.button().props.disabled, false);
  }
});

test('buffering during a drag cancels the preview without seeking an unloaded player', async () => {
  const audio = audioHarness();
  audio.slider().props.onSlidingStart();
  audio.slider().props.onValueChange(70);
  assert.equal(audio.slider().props.value, 70);
  audio.setStatus({ currentTime: 12, isLoaded: false, isBuffering: true, playing: true });
  await audio.slider().props.onSlidingComplete(70);
  assert.equal(audio.calls.seeks.length, 0);
  assert.equal(audio.slider().props.value, 12);
  assert.equal(audio.button().props.disabled, false);
});

test('the playback lifecycle invalidates sessions on blur and background and restores only a focused active session', () => {
  const hookFilename = path.join(__dirname, '../src/components/Message/usePlaybackLifecycle.js');
  const transformed = babel.transformSync(fs.readFileSync(hookFilename, 'utf8'), {
    filename: hookFilename,
    configFile: false,
    babelrc: false,
    plugins: [require('@babel/plugin-transform-modules-commonjs')],
  }).code;
  let focusCallback;
  let focusCleanup;
  let listener;
  let effectCleanup;
  let pauses = 0;
  let removed = 0;
  const appState = {
    currentState: 'active',
    addEventListener(event, callback) {
      assert.equal(event, 'change');
      listener = callback;
      return { remove() { removed += 1; } };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(transformed, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'react') return {
        useRef: (value) => ({ current: value }),
        useCallback: (callback) => callback,
        useEffect(effect) { effectCleanup = effect(); },
      };
      if (name === 'react-native') return { AppState: appState };
      if (name === '@react-navigation/native') return {
        useFocusEffect(callback) {
          focusCallback = callback;
          focusCleanup = callback();
        },
      };
      throw new Error(`Unexpected hook import: ${name}`);
    },
  }, { filename: hookFilename });
  const session = module.exports.default({ pause() { pauses += 1; } });
  assert.equal(session.current.active, true);
  const initialGeneration = session.current.generation;
  focusCleanup();
  assert.equal(session.current.active, false);
  assert.ok(session.current.generation > initialGeneration);
  assert.equal(pauses, 1);

  listener('active');
  assert.equal(session.current.active, false, 'Foregrounding must not activate an unfocused chat');
  focusCleanup = focusCallback();
  assert.equal(session.current.active, true);
  const focusedGeneration = session.current.generation;
  appState.currentState = 'background';
  listener('background');
  assert.equal(session.current.active, false);
  assert.ok(session.current.generation > focusedGeneration);
  assert.equal(pauses, 2);

  focusCleanup();
  focusCleanup = focusCallback();
  assert.equal(session.current.active, false, 'Refocusing in the background must not permit playback');
  appState.currentState = 'active';
  listener('active');
  assert.equal(session.current.active, true);
  assert.ok(session.current.generation > focusedGeneration, 'An earlier async play must remain invalid after foregrounding');
  effectCleanup();
  assert.equal(removed, 1);
});

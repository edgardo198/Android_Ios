const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

function load(relativePath, mocks = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false,
    plugins: [[require('babel-plugin-syntax-hermes-parser'), { parseLangTypes: 'flow' }],
      require('@babel/plugin-transform-flow-strip-types'), [require('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }],
      require('@babel/plugin-transform-modules-commonjs')],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, setTimeout, clearTimeout,
    require(name) { if (!(name in mocks)) throw new Error(`Missing mock: ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}

test('an offline typing attempt leaves no timer and an old idle callback cannot stop the next typing session', () => {
  const { createTypingController } = load('src/core/typing.js');
  const events = [];
  const timers = new Map();
  let available = false, sequence = 0;
  const controller = createTypingController((typing) => {
    if (!available) return false;
    events.push(typing); return true;
  }, { now: () => 0,
    setTimer(callback) { timers.set(++sequence, callback); return sequence; },
    clearTimer(id) { timers.delete(id); },
  });
  assert.equal(controller.change('offline'), false);
  assert.equal(timers.size, 0);
  available = true;
  controller.change('first');
  const oldIdle = [...timers.values()][0];
  controller.stop();
  controller.change('second');
  oldIdle();
  assert.deepEqual(events, [true, false, true]);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.deepEqual(events, [true, false, true, false]);
  assert.equal(timers.size, 0);
});

test('live drafts throttle continuous input to the latest text and stop cancels delayed content', () => {
  const { createTypingController, boundedTypingDraft } = load('src/core/typing.js');
  let now = 0, next = 0;
  const timers = new Map(), events = [];
  const advance = (amount) => {
    const target = now + amount;
    while (true) {
      const first = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > target) break;
      now = first[1].at; timers.delete(first[0]); first[1].callback();
    }
    now = target;
  };
  const controller = createTypingController((typing, draft) => { events.push({ typing, draft, at: now }); return true; }, {
    now: () => now, getDraft: (text) => text,
    setTimer(callback, delay) { timers.set(++next, { callback, at: now + delay }); return next; },
    clearTimer(id) { timers.delete(id); },
  });
  controller.change('First');
  assert.deepEqual(events[0], { typing: true, draft: 'First', at: 0 });
  for (let i = 1; i <= 20; i++) { advance(100); controller.change(`latest ${i}`); }
  assert.ok(events.filter((event) => event.typing).length >= 5, 'continuous input publishes without requiring a pause');
  assert.ok(events.filter((event) => event.typing).every((event, index, all) => !index || event.at - all[index - 1].at >= 350));
  const oldDraft = [...timers.values()].find((timer) => timer.at < now + 1000)?.callback;
  controller.stop();
  assert.equal(timers.size, 0);
  controller.change('New activity');
  const count = events.length;
  oldDraft?.();
  assert.equal(events.length, count, 'a delayed callback cannot emit content from the stopped activity');
  advance(2500);
  assert.equal(events.at(-1).typing, false);
  assert.equal(events.at(-1).draft, null);
  assert.equal(timers.size, 0);
  assert.equal(Array.from(boundedTypingDraft('😀'.repeat(600))).length, 500);
  assert.equal(Buffer.byteLength(boundedTypingDraft('😀'.repeat(600))), 2000);
});

test('a private draft policy disables content without stopping ordinary typing heartbeats', () => {
  const { createTypingController } = load('src/core/typing.js');
  let now = 0, enabled = false;
  const events = [];
  const controller = createTypingController((typing, draft) => { events.push({ typing, draft }); return true; }, {
    now: () => now, getDraft: (text) => enabled ? text : null, setTimer: () => 1, clearTimer() {},
  });
  controller.change('Private'); now = 2100; controller.change('Still private');
  assert.deepEqual(events, [{ typing: true, draft: null }, { typing: true, draft: null }]);
  controller.stop(); enabled = true; controller.change('Explicitly shared');
  assert.deepEqual(events.at(-1), { typing: true, draft: 'Explicitly shared' });
});

function animationHarness(platform, reducedMotion, preferenceQuery, animationApi) {
  const slots = [];
  const timingOptions = [];
  const counters = { starts: 0, stops: 0, removals: 0 };
  let cursor = 0, effects = [], motionChanged, preferenceMode = 'system';
  const react = {
    memo: (component) => component,
    createElement: (type, props) => ({ type, props }),
    useRef(value) { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index]; },
    useState(value) {
      const index = cursor++; if (!(index in slots)) slots[index] = value;
      return [slots[index], (next) => { slots[index] = next; }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || dependencies.some((value, at) => !Object.is(value, previous.dependencies[at]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
      }
    },
  };
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
    interpolate() { return this; }
  }
  const Component = load('src/components/Message/MessageTypingAnimation.js', {
    react, 'react-native': {
      Platform: { OS: platform }, Easing: { linear: (value) => value },
      AccessibilityInfo: {
        async isReduceMotionEnabled() { return preferenceQuery ?? reducedMotion; },
        addEventListener(_event, listener) { motionChanged = listener; return { remove() { counters.removals += 1; } }; },
      },
      Animated: { Value, View: 'Animated.View', delay: (milliseconds) => milliseconds,
        timing(value, options) { timingOptions.push(options); return { value, options }; },
        sequence: (items) => items,
        loop: () => ({ start() { counters.starts += 1; }, stop() { counters.stops += 1; } }),
        ...animationApi,
      },
    },
    '../../core/typingAnimation': { useTypingAnimationMode: () => preferenceMode },
  }).default;
  const render = () => { cursor = 0; effects = []; const tree = Component({ delay: 100 }); effects.forEach((effect) => effect()); return tree; };
  return { counters, timingOptions, render,
    changeMotion(value) { motionChanged(value); return render(); },
    changeMode(value) { preferenceMode = value; return render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test('reduced motion keeps a visible typing dot and preference changes start and stop the animation', async () => {
  const h = animationHarness('web', true);
  assert.equal(h.render().type, 'Animated.View');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.render().type, 'Animated.View');
  assert.equal(h.counters.starts, 0);
  h.changeMotion(false);
  assert.equal(h.counters.starts, 1);
  assert.equal(h.timingOptions.every((options) => options.useNativeDriver === false && options.isInteraction === false), true);
  assert.equal(h.changeMotion(true).type, 'Animated.View');
  assert.equal(h.counters.stops, 1);
  h.changeMotion(false);
  h.unmount();
  assert.equal(h.counters.stops, 2);
  assert.equal(h.counters.removals, 1);
});

test('native typing animates with the native driver without blocking list interactions and stops on unmount', async () => {
  const h = animationHarness('android', false);
  h.render();
  await new Promise((resolve) => setImmediate(resolve));
  h.render();
  assert.equal(h.counters.starts, 1);
  assert.equal(h.timingOptions.every((options) => options.useNativeDriver === true && options.isInteraction === false), true);
  h.unmount();
  assert.equal(h.counters.stops, 1);
  assert.equal(h.counters.removals, 1);
});

test('a late preference query cannot override a new reduced-motion choice', async () => {
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  const h = animationHarness('web', false, pending);
  h.render();
  h.changeMotion(true);
  resolve(false);
  await new Promise((yes) => setImmediate(yes));
  assert.equal(h.render().type, 'Animated.View');
  assert.equal(h.counters.starts, 0);
  h.unmount();
});

test('explicit animation overrides reduced motion and turning it off stops the existing loop', async () => {
  const h = animationHarness('android', true);
  h.render();
  await new Promise((resolve) => setImmediate(resolve)); h.render();
  assert.equal(h.counters.starts, 0);
  h.changeMode('on');
  assert.equal(h.counters.starts, 1);
  h.changeMode('off');
  assert.equal(h.counters.stops, 1);
  h.changeMode('system');
  assert.equal(h.counters.starts, 1);
  h.unmount();
});

test('the installed React Native loop API sends one infinite native timing that retains motion across four cycles', async () => {
  const nativeStarts = [];
  class Node {}
  class NativeValue extends Node {
    constructor(value) { super(); this.value = value; this.active = null; }
    setValue(value) { this.value = value; }
    stopTracking() {}
    animate(animation) { this.active = animation.config; nativeStarts.push(this.active); }
    stopAnimation() { this.active = null; }
    resetAnimation() { this.value = 0; }
    interpolate({ inputRange, outputRange }) {
      return { sampleAt: (time) => {
        const phase = this.active ? (time % this.active.duration) / this.active.duration : this.value;
        let index = 0;
        while (index < inputRange.length - 2 && phase > inputRange[index + 1]) index += 1;
        return outputRange[index] + (phase - inputRange[index]) / (inputRange[index + 1] - inputRange[index]) * (outputRange[index + 1] - outputRange[index]);
      } };
    }
  }
  class Timing { constructor(config) { this.config = config; } }
  const mocks = {};
  for (const name of ['Addition', 'Color', 'DiffClamp', 'Division', 'Interpolation', 'Modulo', 'Multiplication', 'Subtraction', 'Tracking', 'ValueXY']) {
    mocks[`./nodes/Animated${name}`] = class extends Node {};
  }
  Object.assign(mocks, {
    './AnimatedEvent': { AnimatedEvent: class {}, attachNativeEventImpl() {} },
    './animations/DecayAnimation': Timing, './animations/SpringAnimation': Timing, './animations/TimingAnimation': Timing,
    './createAnimatedComponent': (component) => component, './nodes/AnimatedNode': Node, './nodes/AnimatedValue': NativeValue,
  });
  const actualApi = load('node_modules/react-native/Libraries/Animated/AnimatedImplementation.js', mocks).default;
  const h = animationHarness('android', false, undefined, actualApi);
  h.render(); await new Promise((resolve) => setImmediate(resolve));
  const dot = h.render().props.style.transform[0].translateY;
  assert.equal(nativeStarts.length, 1);
  assert.equal(nativeStarts[0].iterations, -1);
  assert.equal(nativeStarts[0].useNativeDriver, true);
  assert.equal(nativeStarts[0].isInteraction, false);
  for (let cycle = 0; cycle < 4; cycle += 1) {
    assert.equal(dot.sampleAt(cycle * 1000 + 100), 0);
    assert.ok(dot.sampleAt(cycle * 1000 + 300) < -7.9);
    assert.ok(Math.abs(dot.sampleAt(cycle * 1000 + 600)) < 0.01);
  }
  h.unmount();
  assert.equal(dot.sampleAt(300), 0);
});

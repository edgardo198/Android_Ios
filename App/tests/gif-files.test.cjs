const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const babel = require('@babel/core');

function load(relative, mocks = {}) {
  const filename = path.join(__dirname, '..', relative);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Uint8Array,
    require(name) { if (!(name in mocks)) throw new Error(`Missing mock: ${name}`); return mocks[name]; },
  }, { filename });
  return module.exports;
}
const metadata = load('src/components/Message/mediaMetadata.js');
const gifs = load('src/components/Message/gifFiles.js', { './mediaMetadata': metadata });

test('GIF preparation preserves the original File bytes, URI and animated format', async () => {
  // Two image descriptors are deliberately retained without transformation.
  const bytes = Buffer.from('GIF89a\u0001\u0000\u0001\u0000,frame-one,frame-two;');
  const file = new Blob([bytes], { type: 'image/gif' });
  const result = await gifs.prepareGifAsset({ uri: 'blob:original', name: '../animated.GIF', file, size: file.size });
  assert.equal(result.uri, 'blob:original');
  assert.equal(result.file, file);
  assert.equal(result.fileName, 'animated.GIF');
  assert.equal(result.mimeType, 'image/gif');
  assert.deepEqual(Buffer.from(await result.file.arrayBuffer()), bytes);
  assert.equal(gifs.isGifImage(result.fileName), true);
});

test('GIF selection rejects nonlocal sources, extension/MIME mismatches and forged browser headers', async () => {
  const cases = [
    { uri: 'https://example.invalid/file.gif', name: 'file.gif' },
    { uri: 'content://local/1', name: 'renamed.png', mimeType: 'image/gif' },
    { uri: 'file:///renamed.gif', name: 'renamed.gif', mimeType: 'image/jpeg' },
    { uri: 'blob:forged', name: 'forged.gif', file: new Blob(['notgif'], { type: 'image/gif' }) },
  ];
  for (const asset of cases) await assert.rejects(() => gifs.prepareGifAsset(asset), /GIF|\.gif/);
});

test('empty and oversized GIFs are rejected before reading, while the exact limit is accepted', async () => {
  let reads = 0;
  const unread = { type: 'image/gif', size: gifs.GIF_MAX_BYTES + 1,
    slice() { reads += 1; throw new Error('Should not read oversized file'); } };
  await assert.rejects(() => gifs.prepareGifAsset({ uri: 'blob:large', name: 'large.gif', file: unread }), /10 MB/);
  assert.equal(reads, 0);
  await assert.rejects(() => gifs.prepareGifAsset({ uri: 'file:///empty.gif', size: 0 }), /vacío/);
  const result = await gifs.prepareGifAsset({ uri: 'content://files/1', name: 'limit.gif', size: gifs.GIF_MAX_BYTES,
    mimeType: 'application/octet-stream' });
  assert.equal(result.mimeType, 'image/gif');
  assert.equal(result.size, gifs.GIF_MAX_BYTES);
});

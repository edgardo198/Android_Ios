const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { evalModsAsync, XML } = require('expo/config-plugins');
const withBrandIconInset = require('../plugins/withBrandIconInset');

const originalXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/iconBackground"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
  <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>`;

function fixture(t) {
  const base = path.resolve(__dirname, '../../.tmp/brand-icon-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  assert(root.startsWith(`${base}${path.sep}`));
  t.after(() => { assert(path.resolve(root).startsWith(`${base}${path.sep}`)); fs.rmSync(root, { recursive: true, force: true }); });
  const directory = path.join(root, 'android/app/src/main/res/mipmap-anydpi-v26');
  fs.mkdirSync(directory, { recursive: true });
  const files = ['ic_launcher.xml', 'ic_launcher_round.xml'].map((name) => path.join(directory, name));
  const config = withBrandIconInset({ name: 'Brand fixture', slug: 'brand-fixture',
    android: { adaptiveIcon: { foregroundImage: './assets/brand/adaptive-foreground.png', backgroundColor: '#FFFFFF' } } });
  config.mods.android.finalized.isProvider = true;
  return { root, files, config, write(value = originalXml) { files.forEach((file) => fs.writeFileSync(file, value)); },
    async run() { return evalModsAsync(config, { projectRoot: root, platforms: ['android'] }); } };
}

test('the real Expo compiler applies the inset after regenerated adaptive icons, regardless of mod registration order', async (t) => {
  const h = fixture(t);
  // Register the simulated Expo generator after our plugin, when finalized is
  // already the first property. The real compiler must still run finalized last.
  h.config.mods.android.dangerous = async (result) => { h.write(); return result; };
  h.config.mods.android.dangerous.isProvider = true;
  await h.run();
  for (const file of h.files) {
    const icon = (await XML.parseXMLAsync(fs.readFileSync(file, 'utf8')))['adaptive-icon'];
    assert.equal(icon.background[0].$['android:drawable'], '@color/iconBackground');
    assert.equal(icon.monochrome[0].$['android:drawable'], '@mipmap/ic_launcher_monochrome');
    assert.equal(icon.foreground[0].$?.['android:drawable'], undefined);
    const inset = icon.foreground[0].inset;
    assert.equal(inset.length, 1);
    assert.equal(inset[0].$['android:drawable'], '@mipmap/ic_launcher_foreground');
    for (const edge of ['Left', 'Top', 'Right', 'Bottom']) assert.equal(inset[0].$[`android:inset${edge}`], '21dp');
  }
});

test('repeated plugin execution and regenerated prebuilds keep one inset and identical XML without touching the PNG assets', async (t) => {
  const h = fixture(t); h.write();
  const assets = ['icon.png', 'adaptive-foreground.png', 'favicon.png'].map((name) => path.join(__dirname, '../assets/brand', name));
  const before = assets.map((file) => fs.readFileSync(file));
  await h.run();
  const first = h.files.map((file) => fs.readFileSync(file, 'utf8'));
  await h.run();
  assert.deepEqual(h.files.map((file) => fs.readFileSync(file, 'utf8')), first);
  h.write(); await h.run();
  assert.deepEqual(h.files.map((file) => fs.readFileSync(file, 'utf8')), first);
  assets.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
});

test('unsupported foreground resources fail before either launcher XML is changed', async (t) => {
  const h = fixture(t); h.write();
  const unexpected = originalXml.replace('@mipmap/ic_launcher_foreground', '@drawable/another_icon');
  fs.writeFileSync(h.files[1], unexpected);
  await assert.rejects(h.run(), /foreground de icono adaptativo generado por Expo/);
  assert.equal(fs.readFileSync(h.files[0], 'utf8'), originalXml);
  assert.equal(fs.readFileSync(h.files[1], 'utf8'), unexpected);
});

test('standard icon configurations do not install an adaptive resource modifier', () => {
  const config = { name: 'Standard icon', icon: './icon.png', android: {} };
  assert.equal(withBrandIconInset(config), config);
  assert.equal(config.mods, undefined);
});

test('all configured brand PNGs remain exact copies of the supplied image and the plugin is registered once', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8')).expo;
  assert.equal(config.plugins.filter((entry) => entry === './plugins/withBrandIconInset').length, 1);
  assert.equal(config.android.adaptiveIcon.backgroundColor, '#FFFFFF');
  const sourceHash = '1ff67f7c72416a1bddc4bb8aa7bd0c4da3fe0a23af5c3f81835e23316a581d89';
  for (const file of [config.icon, config.web.favicon, config.android.adaptiveIcon.foregroundImage]) {
    const bytes = fs.readFileSync(path.resolve(__dirname, '..', file));
    assert.equal(bytes.readUInt32BE(16), 1254); assert.equal(bytes.readUInt32BE(20), 1254);
    assert.equal(bytes.length, 1345725);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sourceHash);
  }
});

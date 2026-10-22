const fs = require('node:fs/promises');
const path = require('node:path');
const { withFinalizedMod, XML } = require('expo/config-plugins');

const foregroundDrawable = '@mipmap/ic_launcher_foreground';

async function insetForeground(contents) {
  const xml = await XML.parseXMLAsync(contents);
  const icon = xml?.['adaptive-icon'];
  const foreground = icon?.foreground?.[0];
  const drawable = foreground?.$?.['android:drawable'] || foreground?.inset?.[0]?.$?.['android:drawable'];
  if (!icon || icon.foreground?.length !== 1 || drawable !== foregroundDrawable) {
    throw new Error('withBrandIconInset requiere el foreground de icono adaptativo generado por Expo.');
  }
  const attributes = { ...foreground.$ };
  delete attributes['android:drawable'];
  // Expo generates a 108dp layer. A 21dp inset leaves its central 66dp safe zone;
  // the provided PNG remains unchanged and Android scales the drawable at runtime.
  icon.foreground = [{
    ...(Object.keys(attributes).length ? { $: attributes } : {}),
    inset: [{ $: {
      'android:drawable': foregroundDrawable,
      'android:insetLeft': '21dp', 'android:insetTop': '21dp',
      'android:insetRight': '21dp', 'android:insetBottom': '21dp',
    } }],
  }];
  return `<?xml version="1.0" encoding="utf-8"?>\n${XML.format(xml)}\n`;
}

module.exports = function withBrandIconInset(config) {
  if (!config.android?.adaptiveIcon?.foregroundImage) return config;
  // Finalized mods run after Expo's dangerous icon-generation mod, including
  // repeated prebuilds that recreate these XML files from the original asset.
  return withFinalizedMod(config, ['android', async (result) => {
    const directory = path.join(result.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'mipmap-anydpi-v26');
    const files = ['ic_launcher.xml', 'ic_launcher_round.xml'].map((name) => path.join(directory, name));
    // Validate both before writing either, so an unexpected resource fails cleanly.
    const transformed = await Promise.all(files.map(async (file) => insetForeground(await fs.readFile(file, 'utf8'))));
    await Promise.all(files.map((file, index) => fs.writeFile(file, transformed[index], 'utf8')));
    return result;
  }]);
};

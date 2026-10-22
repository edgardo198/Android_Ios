const { withAndroidManifest, withAppBuildGradle } = require('expo/config-plugins');

const marker = '// chatlocal: API environment inputs for the embedded bundle';

function resolveApiUrl(value) {
  if (!value || !value.trim()) return null;
  const candidate = value.trim();
  const invalid = () => new Error('EXPO_PUBLIC_API_URL debe ser una URL HTTP o HTTPS sin credenciales, query ni fragmento.');
  if (!/^https?:\/\//i.test(candidate) || /[\s\\?#]/.test(candidate) || /^https?:\/\/[^/]*@/i.test(candidate)) {
    throw invalid();
  }
  let url;
  try { url = new URL(candidate); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.port === '0') throw invalid();
  return url;
}

module.exports = function withApiTransport(config) {
  const apiUrl = resolveApiUrl(process.env.EXPO_PUBLIC_API_URL);
  config = withAndroidManifest(config, (result) => {
    const application = result.modResults.manifest.application?.[0];
    if (!application) throw new Error('No se encontro application en el manifiesto Android.');
    application.$ ||= {};
    // HTTP is an explicit local-build choice. HTTPS and unconfigured builds stay protected.
    application.$['android:usesCleartextTraffic'] = apiUrl?.protocol === 'http:' ? 'true' : 'false';
    return result;
  });
  return withAppBuildGradle(config, (result) => {
    if (result.modResults.language !== 'groovy') {
      throw new Error('withApiTransport requiere la plantilla Gradle Groovy de Expo.');
    }
    if (!result.modResults.contents.includes(marker)) {
      // RN watches JS/TS sources but does not track shell variables. Invalidate only the
      // bundle task when its public API address or build mode changes, preserving native caches.
      result.modResults.contents += `\n${marker}\ntasks.withType(com.facebook.react.tasks.BundleHermesCTask).configureEach {
    inputs.property("chatlocalApiUrl", providers.environmentVariable("EXPO_PUBLIC_API_URL").orElse(""))
    inputs.property("chatlocalNodeEnv", providers.environmentVariable("NODE_ENV").orElse(""))
    inputs.property("chatlocalBabelEnv", providers.environmentVariable("BABEL_ENV").orElse(""))
    inputs.property("chatlocalInlineEnv", providers.environmentVariable("EXPO_NO_CLIENT_ENV_VARS").orElse(""))
}\n`;
    }
    return result;
  });
};

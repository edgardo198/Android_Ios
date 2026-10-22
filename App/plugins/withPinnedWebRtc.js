const { withProjectBuildGradle } = require('expo/config-plugins');

// The npm engine requests 124.+. Pin its Android binary as well as its JS package.
const marker = '// chatlocal: pinned WebRTC Android binary';
module.exports = function withPinnedWebRtc(config) {
  return withProjectBuildGradle(config, (result) => {
    if (result.modResults.language !== 'groovy') {
      throw new Error('The WebRTC dependency pin requires the Expo Groovy Android template.');
    }
    if (!result.modResults.contents.includes(marker)) {
      result.modResults.contents += `\n${marker}\nallprojects {
  configurations.configureEach {
    resolutionStrategy.eachDependency { details ->
      if (details.requested.group == 'org.jitsi' && details.requested.name == 'webrtc') {
        details.useVersion('124.0.0')
        details.because('Keep the local native calling build reproducible')
      }
    }
  }
}\n`;
    }
    return result;
  });
};

const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withMainApplication, withDangerousMod } = require('expo/config-plugins');

module.exports = function withCallService(config) {
  config = withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    manifest['uses-permission'] ||= [];
    for (const name of ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MICROPHONE', 'FOREGROUND_SERVICE_CAMERA', 'FOREGROUND_SERVICE_REMOTE_MESSAGING',
      'RECORD_AUDIO', 'CAMERA', 'WAKE_LOCK', 'MODIFY_AUDIO_SETTINGS', 'BLUETOOTH_CONNECT', 'POST_NOTIFICATIONS', 'ACCESS_NETWORK_STATE', 'INTERNET']) {
      const permission = `android.permission.${name}`;
      if (!manifest['uses-permission'].some((entry) => entry.$?.['android:name'] === permission)) {
        manifest['uses-permission'].push({ $: { 'android:name': permission } });
      }
    }
    if (!manifest['uses-permission'].some((entry) => entry.$?.['android:name'] === 'android.permission.BLUETOOTH')) {
      manifest['uses-permission'].push({ $: { 'android:name': 'android.permission.BLUETOOTH', 'android:maxSdkVersion': '30' } });
    }
    const application = manifest.application[0];
    application.service ||= [];
    const name = 'com.chatlocal.calls.CallService';
    const service = { $: { 'android:name': name, 'android:exported': 'false',
      'android:foregroundServiceType': 'microphone|camera', 'android:stopWithTask': 'false' } };
    const index = application.service.findIndex((entry) => entry.$?.['android:name'] === name);
    if (index < 0) application.service.push(service);
    else application.service[index] = service;
    const noticeName = 'com.chatlocal.calls.NoticeService';
    const noticeService = { $: { 'android:name': noticeName, 'android:exported': 'false',
      'android:foregroundServiceType': 'remoteMessaging', 'android:stopWithTask': 'false' } };
    const noticeIndex = application.service.findIndex((entry) => entry.$?.['android:name'] === noticeName);
    if (noticeIndex < 0) application.service.push(noticeService);
    else application.service[noticeIndex] = noticeService;
    return result;
  });
  config = withMainApplication(config, (result) => {
    if (result.modResults.language !== 'kt') throw new Error('CallService requires the Expo Kotlin MainApplication template.');
    let contents = result.modResults.contents;
    if (!contents.includes('import com.chatlocal.calls.CallPackage')) {
      contents = contents.replace(/(package [^\r\n]+\r?\n)/, '$1\nimport com.chatlocal.calls.CallPackage\n');
    }
    if (!contents.includes('add(CallPackage())')) {
      const anchor = 'PackageList(this).packages.apply {';
      if (!contents.includes(anchor)) throw new Error('CallService could not find the Expo package registration block.');
      contents = contents.replace(anchor, `${anchor}\n          add(CallPackage())`);
    }
    result.modResults.contents = contents;
    return result;
  });
  return withDangerousMod(config, ['android', (result) => {
    const source = path.join(__dirname, 'call-service', 'android');
    const destination = path.join(result.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', 'com', 'chatlocal', 'calls');
    fs.mkdirSync(destination, { recursive: true });
    for (const file of fs.readdirSync(source).filter((name) => name.endsWith('.kt'))) {
      fs.writeFileSync(path.join(destination, file), fs.readFileSync(path.join(source, file)));
    }
    return result;
  }]);
};

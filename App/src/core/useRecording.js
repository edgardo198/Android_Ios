import { Alert, AppState, Platform } from 'react-native';
import { useState, useRef, useCallback, useEffect } from 'react';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';

export default function useRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparingRecording, setIsPreparingRecording] = useState(false);
  const operationRef = useRef(null);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const restoreAudioMode = useCallback(() =>
    setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false }).catch(() => {}), []);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY, (status) => {
    if (activeRef.current && (status.isFinished || status.hasError || status.mediaServicesDidReset)) {
      activeRef.current = false;
      generationRef.current += 1;
      if (mountedRef.current) {
        setIsRecording(false);
        if (status.hasError) Alert.alert('Grabación interrumpida', 'No se pudo completar el audio. Intenta nuevamente.');
      }
      void restoreAudioMode();
    }
  });

  const stopRecording = useCallback(async () => {
    if (operationRef.current || !activeRef.current) return null;
    activeRef.current = false;
    if (mountedRef.current) { setIsRecording(false); setIsPreparingRecording(true); }
    const operation = (async () => {
      try {
        await recorder.stop();
        return recorder.uri ? { uri: recorder.uri, fileName: `audio-${Date.now()}.m4a`, mimeType: 'audio/mp4' } : null;
      } catch {
        if (mountedRef.current) Alert.alert('Error', 'No se pudo finalizar la grabación.');
        return null;
      } finally {
        await restoreAudioMode();
        if (mountedRef.current) setIsPreparingRecording(false);
      }
    })();
    operationRef.current = operation;
    try { return await operation; } finally { if (operationRef.current === operation) operationRef.current = null; }
  }, [recorder, restoreAudioMode]);

  const cancelRecording = useCallback(async () => {
    generationRef.current += 1;
    if (operationRef.current) await operationRef.current;
    if (activeRef.current) await stopRecording();
  }, [stopRecording]);

  useEffect(() => {
    mountedRef.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') void cancelRecording();
    });
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      subscription.remove();
      if (activeRef.current) {
        activeRef.current = false;
        Promise.resolve().then(() => recorder.stop()).catch(() => {}).finally(restoreAudioMode);
      }
    };
  }, [cancelRecording, recorder, restoreAudioMode]);

  const startRecording = useCallback(async () => {
    if (operationRef.current || activeRef.current || Platform.OS === 'web') return false;
    const generation = generationRef.current;
    setIsPreparingRecording(true);
    const operation = (async () => {
      let prepared = false;
      let modeEnabled = false;
      try {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!permission.granted) {
          if (mountedRef.current) Alert.alert('Permiso requerido', 'Activa el permiso del micrófono para grabar audio.');
          return false;
        }
        if (!mountedRef.current || generation !== generationRef.current) return false;
        await setAudioModeAsync({
          allowsRecording: true, playsInSilentMode: true, interruptionMode: 'doNotMix',
          allowsBackgroundRecording: false, shouldPlayInBackground: false,
        });
        modeEnabled = true;
        if (!mountedRef.current || generation !== generationRef.current) return false;
        await recorder.prepareToRecordAsync();
        prepared = true;
        if (!mountedRef.current || generation !== generationRef.current) return false;
        recorder.record();
        activeRef.current = true;
        setIsRecording(true);
        return true;
      } catch {
        if (mountedRef.current) Alert.alert('Error', 'No se pudo iniciar la grabación.');
        return false;
      } finally {
        if (!activeRef.current) {
          if (prepared) await recorder.stop().catch(() => {});
          if (modeEnabled) await restoreAudioMode();
        }
        if (mountedRef.current) setIsPreparingRecording(false);
      }
    })();
    operationRef.current = operation;
    try { return await operation; } finally { if (operationRef.current === operation) operationRef.current = null; }
  }, [recorder, restoreAudioMode]);

  return { isRecording, isPreparingRecording, startRecording, stopRecording, cancelRecording };
}

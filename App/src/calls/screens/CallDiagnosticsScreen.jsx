import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import useGlobal from '../../core/global';
import {
  getNativeRtcAvailability, getNativeRtcView, startLocalCapture,
} from '../nativeRtc';

function stopLease(lease) {
  try { lease?.stop(); } catch { /* A released native stream may already be closed. */ }
}

function captureError(error) {
  if (['CAPTURE_UNAVAILABLE', 'CAPTURE_BUSY', 'MICROPHONE_PERMISSION_DENIED', 'CAMERA_PERMISSION_DENIED',
    'CAPTURE_PERMISSION_DENIED', 'CAPTURE_DEVICE_UNAVAILABLE', 'CAPTURE_FAILED'].includes(error?.code) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  if (/permission|denied|notallowed/i.test(`${error?.code || ''} ${error?.name || ''} ${error?.message || ''}`)) {
    return 'Permite el acceso al micrófono y, para la prueba de video, a la cámara. Puedes revisar los permisos en Ajustes.';
  }
  return 'No se pudo iniciar la prueba. Revisa los permisos y vuelve a intentarlo.';
}

export default function CallDiagnosticsScreen({ navigation }) {
  const availability = getNativeRtcAvailability();
  const [phase, setPhase] = useState('idle');
  const [capture, setCapture] = useState(null);
  const [error, setError] = useState(null);
  const [help, setHelp] = useState(null);
  const [muted, setMuted] = useState(false);
  const [frontCamera, setFrontCamera] = useState(true);
  const [switching, setSwitching] = useState(false);
  const mutedRef = useRef(false);
  const cameraSwitch = useRef(null);
  const mounted = useRef(true);
  const focused = useRef(false);
  const generation = useRef(0);
  const operation = useRef(null);
  const leaseRef = useRef(null);
  const appState = useRef(AppState.currentState || 'active');

  const stopTest = useCallback(() => {
    generation.current += 1;
    const pending = operation.current;
    if (pending) {
      pending.cancelled = true;
      pending.controller.abort();
    }
    stopLease(leaseRef.current);
    leaseRef.current = null;
    cameraSwitch.current = null;
    mutedRef.current = false;
    if (mounted.current) {
      setCapture(null);
      setMuted(false);
      setFrontCamera(true);
      setSwitching(false);
      setHelp(null);
      setPhase(pending ? 'stopping' : 'idle');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      appState.current = state;
      if (state !== 'active') {
        const wasStarting = operation.current && !operation.current.cancelled;
        stopTest();
        if (wasStarting && mounted.current) setHelp('La prueba se detuvo. Pulsa de nuevo para iniciarla.');
      }
    });
    const unsubscribe = useGlobal.subscribe((state, previous) => {
      if (!state.authenticated || state.user?.username !== previous.user?.username) stopTest();
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      unsubscribe();
      stopTest();
    };
  }, [stopTest]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    generation.current += 1;
    return () => {
      focused.current = false;
      stopTest();
    };
  }, [stopTest]));

  const startTest = async (video) => {
    const state = useGlobal.getState();
    if (!availability.available || operation.current || leaseRef.current || !mounted.current || !focused.current ||
      appState.current !== 'active' || !state.authenticated) return false;
    const attempt = { controller: new AbortController(), generation: generation.current, username: state.user?.username, cancelled: false };
    operation.current = attempt;
    setError(null);
    setHelp(null);
    setPhase('starting');
    let lease;
    try {
      lease = await startLocalCapture({ video, signal: attempt.controller.signal });
      const current = useGlobal.getState();
      if (attempt.cancelled || attempt.controller.signal.aborted || operation.current !== attempt || !mounted.current ||
        !focused.current || appState.current !== 'active' || generation.current !== attempt.generation ||
        !current.authenticated || current.user?.username !== attempt.username) {
        stopLease(lease);
        return false;
      }
      const CameraView = video ? getNativeRtcView() : null;
      if (video && !CameraView) throw new Error('Camera preview unavailable');
      const streamURL = video ? lease.stream.toURL() : null;
      leaseRef.current = lease;
      setCapture({ video, CameraView, streamURL, canMute: typeof lease.setMicrophoneEnabled === 'function', canSwitch: video && typeof lease.switchCamera === 'function' });
      setMuted(false);
      mutedRef.current = false;
      setFrontCamera(true);
      setPhase('active');
      return true;
    } catch (failure) {
      stopLease(lease);
      if (!attempt.cancelled && !attempt.controller.signal.aborted && mounted.current && focused.current &&
        generation.current === attempt.generation && useGlobal.getState().authenticated &&
        useGlobal.getState().user?.username === attempt.username && failure?.code !== 'CAPTURE_CANCELLED') {
        setError(captureError(failure));
        setPhase('idle');
      }
      return false;
    } finally {
      if (operation.current === attempt) {
        operation.current = null;
        if (mounted.current && leaseRef.current !== lease) setPhase('idle');
      }
    }
  };

  const toggleMicrophone = () => {
    const lease = leaseRef.current;
    if (!lease || typeof lease.setMicrophoneEnabled !== 'function') return;
    try {
      const enabled = mutedRef.current;
      if (lease.setMicrophoneEnabled(enabled) !== false) {
        mutedRef.current = !enabled;
        setMuted(!enabled);
        setError(null);
      }
    } catch { setError('No se pudo cambiar el micrófono. Detén la prueba e intenta nuevamente.'); }
  };

  const switchCamera = async () => {
    const lease = leaseRef.current;
    if (!lease || typeof lease.switchCamera !== 'function' || cameraSwitch.current) return false;
    const attempt = { lease, generation: generation.current };
    cameraSwitch.current = attempt;
    setSwitching(true);
    try {
      const changed = await lease.switchCamera();
      if (cameraSwitch.current !== attempt || leaseRef.current !== lease || !mounted.current || generation.current !== attempt.generation) return false;
      if (changed !== false) {
        setFrontCamera((front) => !front);
        setError(null);
        return true;
      }
      return false;
    } catch {
      if (cameraSwitch.current === attempt && mounted.current && generation.current === attempt.generation) setError('No se pudo cambiar la cámara. Detén la prueba e intenta nuevamente.');
      return false;
    } finally {
      if (cameraSwitch.current === attempt) {
        cameraSwitch.current = null;
        if (mounted.current) setSwitching(false);
      }
    }
  };

  const busy = phase !== 'idle';
  const CameraView = capture?.CameraView;
  const leave = () => { stopTest(); navigation.goBack(); };
  const status = phase === 'starting' ? 'Solicitando acceso…' : phase === 'stopping' ? 'Deteniendo prueba…'
    : phase === 'active' ? capture?.video ? 'Cámara encendida · Audio ' + (muted ? 'deshabilitado' : 'preparado') : 'Audio ' + (muted ? 'deshabilitado' : 'preparado')
      : 'La cámara y el micrófono están apagados.';

  return (
    <SafeAreaView style={styles.page} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={leave} style={styles.back} accessibilityRole="button" accessibilityLabel="Volver al perfil">
          <Text style={styles.backText}>‹ Volver al perfil</Text>
        </TouchableOpacity>
        <Text style={styles.title} accessibilityRole="header">Prueba de llamadas</Text>
        <Text style={styles.description}>Comprueba los permisos de audio y la vista de cámara. El sonido se probará al conectar las llamadas.</Text>
        {!availability.available && <Text style={styles.notice}>{availability.reason || 'Abre la app instalada en Android para realizar esta prueba. Expo Go no incluye esta función.'}</Text>}
        <View style={styles.preview}>
          {CameraView && capture?.streamURL ? <CameraView streamURL={capture.streamURL} style={styles.camera} objectFit="cover" mirror={frontCamera} />
            : <Text style={styles.previewText}>{phase === 'active' ? 'Audio preparado para la prueba' : 'Vista previa de la cámara'}</Text>}
        </View>
        <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
        {help && <Text style={styles.description} accessibilityLiveRegion="polite">{help}</Text>}
        {phase === 'active' && <Text style={styles.description}>Esta prueba todavía no comprueba la captura de sonido.</Text>}
        {error && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
        <TouchableOpacity onPress={() => startTest(false)} style={[styles.button, (!availability.available || busy) && styles.disabled]} disabled={!availability.available || busy} accessibilityRole="button" accessibilityLabel="Preparar audio" accessibilityState={{ disabled: !availability.available || busy }}>
          <Text style={styles.buttonText}>Preparar audio</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => startTest(true)} style={[styles.button, (!availability.available || busy) && styles.disabled]} disabled={!availability.available || busy} accessibilityRole="button" accessibilityLabel="Probar cámara y audio" accessibilityState={{ disabled: !availability.available || busy }}>
          <Text style={styles.buttonText}>Probar cámara y audio</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={stopTest} style={[styles.stopButton, (!busy || phase === 'stopping') && styles.disabled]} disabled={!busy || phase === 'stopping'} accessibilityRole="button" accessibilityLabel="Detener prueba" accessibilityState={{ disabled: !busy || phase === 'stopping' }}>
          {(phase === 'starting' || phase === 'stopping') && <ActivityIndicator size="small" color="#214C72" />}
          <Text style={styles.stopText}>Detener prueba</Text>
        </TouchableOpacity>
        {capture?.canMute && <TouchableOpacity onPress={toggleMicrophone} style={styles.stopButton} accessibilityRole="button" accessibilityLabel={muted ? 'Activar micrófono' : 'Silenciar micrófono'}><Text style={styles.stopText}>{muted ? 'Activar micrófono' : 'Silenciar micrófono'}</Text></TouchableOpacity>}
        {capture?.canSwitch && <TouchableOpacity onPress={switchCamera} disabled={switching} style={[styles.stopButton, switching && styles.disabled]} accessibilityRole="button" accessibilityLabel="Cambiar cámara" accessibilityState={{ disabled: switching, busy: switching }}><Text style={styles.stopText}>Cambiar cámara</Text></TouchableOpacity>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F0F8FF' },
  content: { flexGrow: 1, width: '100%', maxWidth: 560, alignSelf: 'center', padding: 20, gap: 12 },
  back: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  backText: { color: '#214C72', fontSize: 15, fontWeight: '600' },
  title: { color: '#163B5D', fontSize: 25, fontWeight: '700' },
  description: { color: '#365C78', fontSize: 14, lineHeight: 21 },
  notice: { color: '#365C78', backgroundColor: '#FFFFFF', padding: 14, borderRadius: 12, fontSize: 14, lineHeight: 21 },
  preview: { width: '100%', aspectRatio: 4 / 3, overflow: 'hidden', borderRadius: 16, backgroundColor: '#E4EDF5', alignItems: 'center', justifyContent: 'center' },
  camera: { width: '100%', height: '100%' },
  previewText: { color: '#365C78', padding: 20, textAlign: 'center', fontSize: 15 },
  status: { color: '#163B5D', fontSize: 14, lineHeight: 21, fontWeight: '600' },
  error: { color: '#8B2424', backgroundColor: '#FFFFFF', padding: 14, borderRadius: 12, fontSize: 14, lineHeight: 21 },
  button: { minHeight: 52, padding: 14, backgroundColor: '#155EA0', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  stopButton: { minHeight: 48, padding: 12, borderRadius: 12, borderColor: '#A4BDD0', borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  stopText: { color: '#214C72', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  disabled: { opacity: 0.5 },
});

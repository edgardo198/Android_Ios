import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCalls } from './CallsProvider';
import { getNativeRtcView } from './nativeRtc';
import { formatCallDuration, parseCallDate } from './callPresentation';

export function CallDuration({ activeAt, active, durationSeconds }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active || parseCallDate(activeAt) === null) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, activeAt]);
  const start = parseCallDate(activeAt);
  const seconds = active ? start === null ? null : Math.max(0, Math.floor((now - start) / 1000)) : durationSeconds;
  const formatted = formatCallDuration(seconds);
  return formatted === null ? null : <Text style={styles.duration} accessibilityLabel={`Duración de la llamada: ${formatted}`}>Duración: {formatted}</Text>;
}

export function WebCallStream({ stream, video, local = false, mirror = false }) {
  const element = useRef(null);
  const [blocked, setBlocked] = useState(false);
  const playbackGeneration = useRef(0);
  useEffect(() => {
    const media = element.current;
    if (!media) return undefined;
    let cancelled = false;
    playbackGeneration.current += 1;
    media.muted = local;
    media.srcObject = stream || null;
    setBlocked(false);
    if (stream) {
      try { Promise.resolve(media.play()).catch(() => { if (!cancelled && !local) setBlocked(true); }); }
      catch { if (!local) setBlocked(true); }
    }
    return () => {
      cancelled = true;
      playbackGeneration.current += 1;
      media.pause();
      media.srcObject = null;
    };
  }, [local, stream, video]);
  const play = async () => {
    const generation = playbackGeneration.current;
    try {
      await element.current?.play();
      if (generation === playbackGeneration.current) setBlocked(false);
    } catch {
      if (generation === playbackGeneration.current) setBlocked(true);
    }
  };
  const mediaStyle = video ? { width: '100%', height: '100%', objectFit: 'cover', transform: mirror ? 'scaleX(-1)' : undefined }
    : { display: 'none' };
  return (
    <View style={video ? styles.stream : undefined}>
      {video ? <video ref={element} autoPlay playsInline muted={local} aria-label={local ? 'Tu cámara' : 'Video de la otra persona'} style={mediaStyle} />
        : <audio ref={element} autoPlay playsInline muted={local} style={mediaStyle} />}
      {blocked && <View style={[styles.soundPrompt, video && styles.videoSoundPrompt]}>
        <Text style={styles.soundHint} accessibilityLiveRegion="polite">El navegador bloqueó el sonido de la llamada.</Text>
        <TouchableOpacity style={styles.soundButton} onPress={play} accessibilityRole="button" accessibilityLabel="Activar sonido de la llamada"><Text style={styles.secondaryText}>Activar sonido</Text></TouchableOpacity>
      </View>}
    </View>
  );
}

export function CallStream({ stream, video, local = false, mirror = false }) {
  if (!stream) return null;
  if (Platform.OS === 'web') return <WebCallStream stream={stream} video={video} local={local} mirror={mirror} />;
  if (!video) return null;
  const CameraView = getNativeRtcView();
  let streamURL;
  try { streamURL = stream.toURL?.(); } catch { streamURL = null; }
  if (!CameraView || !streamURL) return <Text style={styles.videoHint}>No se pudo mostrar el video.</Text>;
  return <CameraView key={streamURL} streamURL={streamURL} style={styles.stream} objectFit="cover" mirror={local && mirror} />;
}

const endedReasons = {
  rejected: 'La llamada fue rechazada.', busy: 'La otra persona está en otra llamada.',
  timeout: 'No hubo respuesta.', no_answer: 'No hubo respuesta.', cancelled: 'La llamada se canceló.',
  connection_timeout: 'No se pudo conectar la llamada.',
  disconnected: 'La llamada terminó al perder la conexión.', unavailable: 'No se pudo conectar la llamada.',
};

export default function CallOverlay() {
  const calls = useCalls();
  const { call, error, availability } = calls;
  const [working, setWorking] = useState(null);
  const [localError, setLocalError] = useState(null);
  const action = useRef(null);
  const currentCall = useRef(call?.id);
  const mounted = useRef(true);
  currentCall.current = call?.id;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { action.current = null; setWorking(null); setLocalError(null); }, [call?.id]);
  const run = async (name, callback, terminal = false) => {
    if (!callback || (action.current && !(terminal && !action.current.terminal))) return false;
    const operation = { id: call?.id, name, terminal };
    action.current = operation;
    setWorking(name);
    setLocalError(null);
    try { return await callback(); } catch {
      if (action.current === operation && mounted.current && currentCall.current === operation.id) setLocalError('No se pudo completar la acción. Revisa la conexión e intenta nuevamente.');
      return false;
    } finally {
      if (action.current === operation) {
        action.current = null;
        if (mounted.current) setWorking(null);
      }
    }
  };

  if (!call && !error) return null;
  const ended = !call || call.status === 'ended';
  const incoming = call?.direction === 'incoming' && call.status === 'ringing';
  const video = call?.kind === 'video';
  const active = call?.status === 'active';
  const videoEnabled = call?.videoEnabled !== false;
  const remoteVideoEnabled = call?.remoteVideoEnabled !== false;
  const audioRoutes = Array.isArray(calls.audioRoutes) ? calls.audioRoutes.filter((route) => route && route.id != null) : [];
  const displayError = error || localError || calls.audioRouteError;
  const web = Platform.OS === 'web';
  const webPermissionDenied = web && ended && /permiso|permite/i.test(error || call?.reason || localError || '');
  const canAccept = availability?.available && calls.connected && !call?.preparing;
  const busy = !!working;
  const terminalBusy = working === 'end' || working === 'reject' || working === 'dismiss';
  const peer = call?.peer?.name || call?.peer?.username || 'La otra persona';
  const title = !call ? 'No se pudo iniciar la llamada' : ended ? 'Llamada finalizada'
    : incoming ? video ? 'Videollamada entrante' : 'Llamada de audio entrante' : video ? 'Videollamada' : 'Llamada de audio';
  const status = !call ? 'Puedes volver a intentar desde el chat.' : ended ? endedReasons[call?.reason] ||
    (typeof call?.reason === 'string' && call.reason.trim() ? call.reason : 'La llamada terminó.') : active ? 'Llamada en curso'
    : call?.status === 'preparing' || call?.preparing ? 'Preparando llamada…'
    : call?.status === 'connecting' ? 'Conectando…' : incoming ? 'Te está llamando' : 'Esperando respuesta…';
  const close = () => ended ? run('dismiss', calls.dismiss, true)
    : incoming ? run('reject', calls.rejectCall, true) : run('end', calls.endCall, true);
  return (
    <Modal visible animationType="fade" onRequestClose={close} statusBarTranslucent>
      <SafeAreaView style={styles.page} edges={['top', 'left', 'right', 'bottom']}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title} accessibilityRole="header">{title}</Text>
          {call && <Text style={styles.peer} numberOfLines={2}>{peer}</Text>}
          <View style={styles.statusRow}>
            {!ended && !active && <ActivityIndicator color="#155EA0" />}
            <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
          </View>
          {call && (active || ended) && <CallDuration activeAt={call.activeAt} active={active} durationSeconds={call.durationSeconds} />}
          {!ended && !availability?.available && <Text style={styles.notice}>{availability?.reason || 'Las llamadas no están disponibles en esta versión de la app.'}</Text>}
          {!ended && !calls.connected && <Text style={styles.notice}>Sin conexión. No se puede conectar la llamada.</Text>}
          {!ended && web && <Text style={styles.webHint}>Mantén esta pestaña visible durante la llamada.</Text>}
          {!ended && web && !active && !call?.localStream && <Text style={styles.webHint}>Al iniciar o aceptar, permite el micrófono y, para video, la cámara.</Text>}
          {!ended && video && (
            <View style={styles.remoteVideo}>
              {!remoteVideoEnabled ? <>
                <Text style={styles.videoHint}>La otra persona desactivó su video.</Text>
                {call.remoteStream && <CallStream stream={call.remoteStream} video={false} />}
              </> : call.remoteStream ? <CallStream stream={call.remoteStream} video /> : <Text style={styles.videoHint}>Esperando video de {peer}…</Text>}
            </View>
          )}
          {!ended && !video && call.remoteStream && <CallStream stream={call.remoteStream} video={false} />}
          {!ended && video && call.localStream && (
            <View style={styles.localPreview}>
              <Text style={styles.localLabel}>Tu cámara</Text>
              <View style={styles.localVideo}>{videoEnabled ? <CallStream stream={call.localStream} video local mirror={call.frontCamera !== false} /> : <Text style={styles.videoHint}>Tu video está desactivado.</Text>}</View>
            </View>
          )}
          {displayError && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{displayError}</Text>}
          {webPermissionDenied && <Text style={styles.notice}>En los permisos del sitio, junto a la dirección del navegador, permite el micrófono y la cámara. Después vuelve a llamar.</Text>}
          {incoming ? (
            <View style={styles.actions}>
              <TouchableOpacity onPress={() => run('reject', calls.rejectCall, true)} disabled={terminalBusy} style={[styles.endButton, styles.rowButton, terminalBusy && styles.disabled]} accessibilityRole="button" accessibilityLabel="Rechazar llamada" accessibilityState={{ disabled: terminalBusy }}><Text style={styles.primaryText}>Rechazar</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => canAccept && run('accept', calls.acceptCall)} disabled={!canAccept || busy} style={[styles.acceptButton, styles.rowButton, (!canAccept || busy) && styles.disabled]} accessibilityRole="button" accessibilityLabel="Aceptar llamada" accessibilityState={{ disabled: !canAccept || busy, busy: working === 'accept' || !!call.preparing }}><Text style={styles.primaryText}>{working === 'accept' || call.preparing ? 'Aceptando…' : 'Aceptar'}</Text></TouchableOpacity>
            </View>
          ) : ended ? (
            <TouchableOpacity onPress={() => run('dismiss', calls.dismiss, true)} disabled={busy} style={styles.acceptButton} accessibilityRole="button" accessibilityLabel="Cerrar llamada"><Text style={styles.primaryText}>Cerrar</Text></TouchableOpacity>
          ) : (
            <>
              {active && <View style={styles.actions}>
                <TouchableOpacity onPress={() => run('mute', calls.toggleMute)} disabled={busy} style={[styles.secondaryButton, busy && styles.disabled]} accessibilityRole="button" accessibilityLabel={call.muted ? 'Activar micrófono de la llamada' : 'Silenciar micrófono de la llamada'} accessibilityState={{ disabled: busy }}><Text style={styles.secondaryText}>{call.muted ? 'Activar micrófono' : 'Silenciar micrófono'}</Text></TouchableOpacity>
                {video && typeof calls.toggleVideo === 'function' && <TouchableOpacity onPress={() => run('video', calls.toggleVideo)} disabled={busy} style={[styles.secondaryButton, busy && styles.disabled]} accessibilityRole="button" accessibilityLabel={videoEnabled ? 'Desactivar video de la llamada' : 'Activar video de la llamada'} accessibilityState={{ disabled: busy }}><Text style={styles.secondaryText}>{videoEnabled ? 'Desactivar video' : 'Activar video'}</Text></TouchableOpacity>}
                {video && <TouchableOpacity onPress={() => videoEnabled && run('camera', calls.switchCamera)} disabled={busy || !videoEnabled} style={[styles.secondaryButton, (busy || !videoEnabled) && styles.disabled]} accessibilityRole="button" accessibilityLabel="Cambiar cámara de la llamada" accessibilityState={{ disabled: busy || !videoEnabled, busy: working === 'camera' }}><Text style={styles.secondaryText}>Cambiar cámara</Text></TouchableOpacity>}
              </View>}
              {active && audioRoutes.length > 0 && typeof calls.selectAudioRoute === 'function' && <View style={styles.audioRouting}>
                <Text style={styles.routingTitle}>Salida de audio</Text>
                <View style={styles.actions}>{audioRoutes.map((route) => <TouchableOpacity key={String(route.id)} onPress={() => run('route', () => calls.selectAudioRoute(route.id))} disabled={busy} style={[styles.secondaryButton, calls.audioRoute === route.id && styles.selectedRoute, busy && styles.disabled]} accessibilityRole="button" accessibilityLabel={`Usar ${route.label || route.id}`} accessibilityState={{ selected: calls.audioRoute === route.id, disabled: busy }}><Text style={styles.secondaryText}>{route.label || route.id}{calls.audioRoute === route.id ? ' · En uso' : ''}</Text></TouchableOpacity>)}</View>
              </View>}
              <TouchableOpacity onPress={() => run('end', calls.endCall, true)} disabled={terminalBusy} style={[styles.endButton, terminalBusy && styles.disabled]} accessibilityRole="button" accessibilityLabel={active ? 'Colgar llamada' : 'Cancelar llamada'} accessibilityState={{ disabled: terminalBusy }}><Text style={styles.primaryText}>{active ? 'Colgar' : 'Cancelar llamada'}</Text></TouchableOpacity>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F0F8FF' },
  content: { flexGrow: 1, width: '100%', maxWidth: 720, alignSelf: 'center', padding: 20, gap: 16, justifyContent: 'center' },
  title: { color: '#163B5D', fontSize: 25, fontWeight: '700', textAlign: 'center' },
  peer: { color: '#214C72', fontSize: 20, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  statusRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  status: { color: '#365C78', fontSize: 15, lineHeight: 22, textAlign: 'center' },
  duration: { color: '#214C72', fontSize: 16, fontWeight: '600', textAlign: 'center', fontVariant: ['tabular-nums'] },
  webHint: { color: '#365C78', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  notice: { color: '#365C78', fontSize: 14, lineHeight: 21, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14 },
  error: { color: '#8B2424', fontSize: 14, lineHeight: 21, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14 },
  remoteVideo: { width: '100%', aspectRatio: 4 / 3, backgroundColor: '#162D40', borderRadius: 16, overflow: 'hidden', justifyContent: 'center' },
  localPreview: { alignSelf: 'flex-end', width: '45%', maxWidth: 200, minWidth: 112, gap: 6 },
  localLabel: { color: '#365C78', fontSize: 12, textAlign: 'right' },
  localVideo: { width: '100%', aspectRatio: 4 / 3, backgroundColor: '#162D40', borderRadius: 12, overflow: 'hidden' },
  stream: { width: '100%', height: '100%' },
  videoHint: { color: '#FFFFFF', fontSize: 14, lineHeight: 21, textAlign: 'center', padding: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  audioRouting: { gap: 10 },
  routingTitle: { color: '#365C78', fontSize: 14, fontWeight: '600' },
  selectedRoute: { backgroundColor: '#DDECF8', borderColor: '#155EA0' },
  rowButton: { flexGrow: 1, flexBasis: 112 },
  acceptButton: { minHeight: 52, minWidth: 112, padding: 14, borderRadius: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: '#155EA0' },
  endButton: { minHeight: 52, minWidth: 112, padding: 14, borderRadius: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: '#A32929' },
  secondaryButton: { flexGrow: 1, flexBasis: 130, minHeight: 48, padding: 12, borderWidth: 1, borderColor: '#9EB8CC', borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  primaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  secondaryText: { color: '#214C72', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  soundButton: { alignSelf: 'center', backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12, minHeight: 44, justifyContent: 'center' },
  soundPrompt: { alignSelf: 'center', maxWidth: '90%', backgroundColor: '#FFFFFF', borderRadius: 12, padding: 8 },
  videoSoundPrompt: { position: 'absolute', bottom: 12 },
  soundHint: { color: '#365C78', fontSize: 13, lineHeight: 19, textAlign: 'center', paddingHorizontal: 4 },
  disabled: { opacity: 0.5 },
});

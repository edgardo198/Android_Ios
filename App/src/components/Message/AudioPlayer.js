import React, { memo, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import Slider from '@react-native-community/slider';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faPause, faPlay, faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import usePrivateMediaSource from '../../core/usePrivateMediaSource';
import usePlaybackLifecycle from './usePlaybackLifecycle';
import styles from '../../Styles/audioStyles';

function formatDuration(seconds) {
  const value = Math.floor(finiteSeconds(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function finiteSeconds(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

const AudioPlayer = memo(({ audioUri = '', isMe = false }) => {
  const media = usePrivateMediaSource(audioUri);
  const uri = media.uri;
  const player = useAudioPlayer(uri ? { uri } : null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [previewTime, setPreviewTime] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [working, setWorking] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const playbackSession = usePlaybackLifecycle(player);

  useEffect(() => {
    mounted.current = true;
    setLocalError(null);
    setPreviewTime(null);
    return () => { mounted.current = false; };
  }, [uri, media.version]);

  useEffect(() => {
    if (status.error) setLocalError('No se pudo cargar el audio.');
  }, [status.error]);

  const duration = finiteSeconds(status.duration);
  const currentTime = duration > 0
    ? Math.min(finiteSeconds(status.currentTime), duration)
    : finiteSeconds(status.currentTime);
  const position = previewTime ?? currentTime;
  const error = media.error || localError || status.error || (!uri && !media.loading ? 'Audio no disponible.' : null);
  const canSeek = !error && status.isLoaded && duration > 0 && !working;
  const accent = '#155EA0';

  const togglePlayback = async () => {
    if (pending.current || (!uri && !media.error)) return;
    pending.current = true;
    setWorking(true);
    const generation = playbackSession.current.generation;
    try {
      if (error) {
        setLocalError(null);
        setPreviewTime(null);
        if (media.isPrivate) {
          const refreshed = await media.reload();
          if (refreshed === uri && mounted.current && playbackSession.current.active && playbackSession.current.generation === generation) player.replace({ uri: refreshed });
        } else {
          player.replace({ uri });
        }
        return;
      }
      if (status.playing) { player.pause(); return; }
      if (!status.isLoaded) return;
      await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix' });
      if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration)) await player.seekTo(0);
      if (!mounted.current || !playbackSession.current.active || playbackSession.current.generation !== generation) return;
      player.play();
    } catch {
      if (mounted.current) setLocalError('No se pudo reproducir el audio.');
    } finally {
      pending.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  const seek = async (seconds) => {
    if (!canSeek || pending.current) {
      setPreviewTime(null);
      return;
    }
    const target = Math.min(finiteSeconds(seconds), duration);
    pending.current = true;
    setWorking(true);
    setPreviewTime(target);
    try {
      await player.seekTo(target);
    } catch {
      if (mounted.current) setLocalError('No se pudo avanzar el audio.');
    } finally {
      pending.current = false;
      if (mounted.current) {
        setPreviewTime(null);
        setWorking(false);
      }
    }
  };

  const onAccessibilityAction = ({ nativeEvent: { actionName } }) => {
    if (actionName === 'increment') void seek(position + 5);
    if (actionName === 'decrement') void seek(position - 5);
  };
  const webKeyboard = Platform.OS === 'web' ? {
    focusable: canSeek,
    'aria-valuemin': 0,
    'aria-valuemax': duration || 1,
    'aria-valuenow': position,
    'aria-valuetext': `${formatDuration(position)} de ${formatDuration(duration)}`,
    'aria-disabled': !canSeek,
    onKeyDown: (event) => {
      const targets = { ArrowRight: position + 5, ArrowUp: position + 5, ArrowLeft: position - 5, ArrowDown: position - 5, Home: 0, End: duration };
      if (Object.hasOwn(targets, event.key)) {
        event.preventDefault();
        void seek(targets[event.key]);
      }
    },
  } : {};
  const label = error ? 'Reintentar audio' : status.playing ? 'Pausar audio' : 'Reproducir audio';
  const initialLoading = media.loading || (!error && !status.isLoaded && !status.playing);
  const disabled = working || (!uri && !media.error) || initialLoading;

  return (
    <View style={styles.container}>
      <TouchableOpacity
        onPress={togglePlayback}
        style={[styles.button, disabled && styles.buttonDisabled]}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, busy: working || initialLoading }}
      >
        {working || initialLoading ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <FontAwesomeIcon icon={error ? faRotateRight : status.playing ? faPause : faPlay} size={19} color="#FFFFFF" />
        )}
      </TouchableOpacity>
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={1}>
          {error ? 'Audio no disponible' : !status.isLoaded ? 'Cargando audio…' : status.isBuffering ? 'Cargando audio…' : 'Mensaje de audio'}
        </Text>
        {error ? (
          <Text style={styles.errorText} accessibilityRole="alert">Toca el botón para reintentar.</Text>
        ) : (
          <>
            <View
              style={styles.slider}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel="Progreso del audio"
              accessibilityHint="Avanza o retrocede en el audio"
              accessibilityValue={{ min: 0, max: duration || 1, now: position, text: `${formatDuration(position)} de ${formatDuration(duration)}` }}
              accessibilityState={{ disabled: !canSeek }}
              accessibilityActions={[{ name: 'increment', label: 'Avanzar 5 segundos' }, { name: 'decrement', label: 'Retroceder 5 segundos' }]}
              onAccessibilityAction={onAccessibilityAction}
              {...webKeyboard}
            >
              <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={duration || 1}
                value={position}
                disabled={!canSeek}
                minimumTrackTintColor={accent}
                maximumTrackTintColor={isMe ? '#82ADD2' : '#DAE3ED'}
                thumbTintColor={accent}
                tapToSeek
                onSlidingStart={() => setPreviewTime(currentTime)}
                onValueChange={setPreviewTime}
                onSlidingComplete={seek}
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
                {...(Platform.OS === 'web' ? { 'aria-hidden': true } : {})}
              />
            </View>
            <View style={styles.times}>
              <Text style={styles.timeText}>{formatDuration(position)}</Text>
              <Text style={styles.timeText}>{status.isLoaded ? formatDuration(duration) : '--:--'}</Text>
            </View>
          </>
        )}
      </View>
    </View>
  );
});
export default AudioPlayer;

import React, { useEffect } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import usePrivateMediaSource from '../../core/usePrivateMediaSource';
import usePlaybackLifecycle from './usePlaybackLifecycle';

function Playback({ media, resizeMode, isLooping, useNativeControls }) {
  // Construct with the source instead of replacing it: Expo's web replaceAsync
  // starts playback. A new source/version remounts this child and releases the
  // previous player, so retries and account changes remain paused and isolated.
  const player = useVideoPlayer({ uri: media.uri, useCaching: !media.isPrivate });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  usePlaybackLifecycle(player);
  useEffect(() => { player.loop = isLooping; }, [isLooping, player]);
  return <>
    <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={useNativeControls} contentFit={resizeMode} surfaceType="textureView" />
    {status === 'loading' && <ActivityIndicator style={styles.overlay} color="#303040" />}
    {status === 'error' && <VideoError message="No se pudo reproducir el video." media={media} />}
  </>;
}

function VideoError({ message, media }) {
  return <View style={styles.overlay}>
    <Text style={styles.error} accessibilityRole="alert">{message}</Text>
    <TouchableOpacity style={styles.retry} onPress={() => media.reload()} disabled={media.loading} accessibilityRole="button" accessibilityLabel="Reintentar video">
      <Text style={styles.retryText}>Reintentar</Text>
    </TouchableOpacity>
  </View>;
}

export default function VideoPlayer({ source, style, resizeMode = 'contain', isLooping = false, useNativeControls = true }) {
  const uri = typeof source === 'string' ? source : source?.uri;
  const media = usePrivateMediaSource(uri);
  return (
    <View style={style}>
      {media.uri && <Playback key={`${media.uri}:${media.version}`} media={media} resizeMode={resizeMode} isLooping={isLooping} useNativeControls={useNativeControls} />}
      {media.loading && !media.error && <ActivityIndicator style={styles.overlay} color="#303040" />}
      {media.error && <VideoError message={media.error} media={media} />}
    </View>
  );
}
const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  error: { color: '#b91c1c', backgroundColor: '#fff', padding: 8, textAlign: 'center' },
  retry: { backgroundColor: '#fff', minHeight: 44, paddingHorizontal: 14, justifyContent: 'center' },
  retryText: { color: '#155EA0', fontWeight: '600' },
});

import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

export default function usePlaybackLifecycle(player) {
  const focused = useRef(false);
  const session = useRef({ active: false, generation: 0 });
  const pause = useCallback(() => {
    try { player.pause(); } catch { /* The native player may already have been released. */ }
  }, [player]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    session.current.active = !AppState.currentState || AppState.currentState === 'active';
    session.current.generation += 1;
    return () => {
      focused.current = false;
      session.current.active = false;
      session.current.generation += 1;
      pause();
    };
  }, [pause]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      session.current.active = focused.current && state === 'active';
      if (state !== 'active') {
        session.current.generation += 1;
        pause();
      }
    });
    return () => subscription.remove();
  }, [pause]);
  return session;
}

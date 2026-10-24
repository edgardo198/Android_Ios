import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import useGlobal from './global';
import { resolveMediaUrl } from './api';
import { getMediaSessionGeneration, getMediaSource, isPrivateMediaSource, mediaSourceError, subscribeMediaSession } from './privateMedia';

export default function usePrivateMediaSource(source) {
  const authenticated = useGlobal((state) => state.authenticated);
  const username = useGlobal((state) => state.user?.username);
  const generation = useSyncExternalStore(subscribeMediaSession, getMediaSessionGeneration, getMediaSessionGeneration);
  const isPrivate = isPrivateMediaSource(source);
  const binding = JSON.stringify([source, authenticated, username, generation]);
  const [state, setState] = useState({ binding, uri: isPrivate ? null : resolveMediaUrl(source), loading: isPrivate, error: null, unavailable: false, version: 0 });
  const request = useRef(0);
  const mounted = useRef(false);
  const latestBinding = useRef(binding);
  const attemptedRecovery = useRef(null);
  const latestSource = useRef(null);
  latestBinding.current = binding;
  const reload = useCallback(async (forceRefresh = true, recovering = false) => {
    if (latestBinding.current !== binding) return null;
    if (!recovering) attemptedRecovery.current = null;
    const current = ++request.current;
    if (!isPrivate) {
      const uri = resolveMediaUrl(source);
      if (mounted.current) setState((previous) => ({ binding, uri, loading: false, error: null, unavailable: false, version: previous.version + 1 }));
      return uri;
    }
    if (mounted.current) setState((previous) => ({ ...previous, binding, uri: null, loading: true, error: null, unavailable: false }));
    try {
      const uri = await getMediaSource(source, { forceRefresh });
      if (!mounted.current || current !== request.current || latestBinding.current !== binding) return null;
      setState((previous) => ({ binding, uri, loading: false, error: null, unavailable: false, version: previous.version + 1 }));
      return uri;
    } catch (error) {
      if (mounted.current && current === request.current && latestBinding.current === binding) {
        setState((previous) => ({ ...previous, uri: null, loading: false, ...mediaSourceError(error) }));
      }
      return null;
    }
  }, [source, isPrivate, authenticated, username, generation, binding]);

  useEffect(() => {
    mounted.current = true;
    void reload(false);
    return () => { mounted.current = false; request.current += 1; };
  }, [reload]);

  // Never expose the previous account's ticket for the render before effect cleanup.
  const visible = state.binding !== binding || (isPrivate && !authenticated)
    ? { uri: isPrivate ? null : resolveMediaUrl(source), loading: isPrivate && authenticated, error: null, unavailable: false, version: state.version }
    : state;
  latestSource.current = { binding, uri: visible.uri };
  const onLoadError = useCallback(async (failedUri) => {
    if (!mounted.current || latestBinding.current !== binding ||
        !failedUri || latestSource.current?.uri !== failedUri) return null;
    if (isPrivate && attemptedRecovery.current !== binding) {
      attemptedRecovery.current = binding;
      return reload(true, true);
    }
    setState((previous) => ({ ...previous, loading: false,
      error: 'No se pudo cargar la imagen. Comprueba tu conexión e intenta de nuevo.' }));
    return null;
  }, [binding, isPrivate, reload]);
  return { ...visible, isPrivate, reload, onLoadError };
}

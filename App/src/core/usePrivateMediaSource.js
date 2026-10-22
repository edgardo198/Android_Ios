import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import useGlobal from './global';
import { resolveMediaUrl } from './api';
import { getMediaSessionGeneration, getMediaSource, isPrivateMediaSource, subscribeMediaSession } from './privateMedia';

export default function usePrivateMediaSource(source) {
  const authenticated = useGlobal((state) => state.authenticated);
  const username = useGlobal((state) => state.user?.username);
  const generation = useSyncExternalStore(subscribeMediaSession, getMediaSessionGeneration, getMediaSessionGeneration);
  const isPrivate = isPrivateMediaSource(source);
  const binding = JSON.stringify([source, authenticated, username, generation]);
  const [state, setState] = useState({ binding, uri: isPrivate ? null : resolveMediaUrl(source), loading: isPrivate, error: null, version: 0 });
  const request = useRef(0);
  const mounted = useRef(false);
  const latestBinding = useRef(binding);
  latestBinding.current = binding;
  const reload = useCallback(async (forceRefresh = true) => {
    if (latestBinding.current !== binding) return null;
    const current = ++request.current;
    if (!isPrivate) {
      const uri = resolveMediaUrl(source);
      if (mounted.current) setState((previous) => ({ binding, uri, loading: false, error: null, version: previous.version + 1 }));
      return uri;
    }
    if (mounted.current) setState((previous) => ({ ...previous, binding, uri: null, loading: true, error: null }));
    try {
      const uri = await getMediaSource(source, { forceRefresh });
      if (!mounted.current || current !== request.current || latestBinding.current !== binding) return null;
      setState((previous) => ({ binding, uri, loading: false, error: null, version: previous.version + 1 }));
      return uri;
    } catch (error) {
      if (mounted.current && current === request.current) {
        const explanation = [401, 403].includes(error.response?.status) ? 'No tienes acceso a este archivo.'
          : error.response?.status === 404 ? 'El archivo no está disponible.'
            : error.message || 'No se pudo abrir el archivo.';
        setState((previous) => ({ ...previous, uri: null, loading: false, error: explanation }));
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
    ? { uri: isPrivate ? null : resolveMediaUrl(source), loading: isPrivate && authenticated, error: null, version: state.version }
    : state;
  return { ...visible, isPrivate, reload };
}

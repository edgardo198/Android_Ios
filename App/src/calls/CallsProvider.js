import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import api, { getAccessToken, getWsBaseUrl } from '../core/api';
import useGlobal from '../core/global';
import { createCallClient } from './callClient';
import { createRtcSession, getCallAvailability } from './rtcSession';
import { getCallNativeAvailability, startCallNativeSession } from './callNativeSession';

const CallsContext = createContext(null);

export function CallsProvider({ children }) {
  const reference = useRef(null);
  if (!reference.current) {
    const background = getCallNativeAvailability();
    reference.current = createCallClient({
      request: async (method, url, data) => (await api({ method, url, data, timeout: 15000 })).data,
      getToken: getAccessToken, getWsUrl: getWsBaseUrl,
      getIdentity: () => useGlobal.getState().authenticated ? useGlobal.getState().user?.username : null,
      getAuthVersion: () => useGlobal.getState().user?.authVersion || 0,
      onAuthInvalidated: ({ username, authVersion }) => useGlobal.getState().invalidateAuthSession(authVersion, username),
      makeSocket: (url) => new WebSocket(url), makeRtc: createRtcSession,
      makeNativeSession: background.available ? startCallNativeSession : undefined,
      uuid: () => Crypto.randomUUID(), availability: { ...getCallAvailability(),
        backgroundAvailable: background.available, backgroundReason: background.reason },
    });
  }
  const client = reference.current;
  const [state, setState] = useState(client.getState);
  useEffect(() => client.subscribe(setState), [client]);
  useEffect(() => {
    client.setForeground(Platform.OS === 'web' ? globalThis.document?.visibilityState !== 'hidden'
      : !AppState.currentState || AppState.currentState === 'active');
    const applyIdentity = (state) => {
      if (state.authenticated && state.user?.username) client.activate(state.user.username);
      else client.deactivate();
    };
    applyIdentity(useGlobal.getState());
    // Zustand notifies synchronously, including logout/login of the same account
    // batched into one React render. Media must stop at the actual logout.
    const unsubscribe = useGlobal.subscribe((next, previous) => {
      if (next.authenticated !== previous.authenticated || next.user?.username !== previous.user?.username) applyIdentity(next);
    });
    return () => { unsubscribe(); client.deactivate(); };
  }, [client]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => client.setForeground(next === 'active'));
    const onVisibility = () => client.setForeground(globalThis.document?.visibilityState !== 'hidden');
    const onPageExit = () => client.setForeground(false);
    if (Platform.OS === 'web') {
      globalThis.document?.addEventListener('visibilitychange', onVisibility);
      globalThis.addEventListener?.('pagehide', onPageExit);
    }
    return () => {
      subscription.remove();
      globalThis.document?.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener?.('pagehide', onPageExit);
    };
  }, [client]);
  return <CallsContext.Provider value={{ ...state, startCall: client.startCall, acceptCall: client.acceptCall,
    rejectCall: client.rejectCall, endCall: client.endCall, toggleMute: client.toggleMute,
    toggleVideo: client.toggleVideo, selectAudioRoute: client.selectAudioRoute,
    switchCamera: client.switchCamera, dismiss: client.dismiss }}>{children}</CallsContext.Provider>;
}

export function useCalls() {
  const context = useContext(CallsContext);
  if (!context) throw new Error('CallsProvider debe envolver la aplicación.');
  return context;
}

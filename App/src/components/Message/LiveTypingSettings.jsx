import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import useGlobal from '../../core/global';

export default function LiveTypingSettings({ embedded = false } = {}) {
  const enabled = useGlobal((state) => state.user?.liveTypingEnabled === true);
  const ready = useGlobal((state) => state.authenticated && state.outboxIdentityVerified);
  const busy = useGlobal((state) => state.liveTypingUpdating);
  const update = useGlobal((state) => state.updateLiveTyping);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  const working = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => useGlobal.subscribe((state, previous) => {
    if (state.authenticated !== previous.authenticated || state.user?.username !== previous.user?.username) {
      working.current = null;
      setError(null);
    }
  }), []);
  const toggle = async () => {
    if (!mounted.current || working.current || !ready || busy) return;
    const snapshot = useGlobal.getState().captureAuthSession();
    const operation = {};
    working.current = operation;
    setError(null);
    try { await update(!enabled); }
    catch {
      if (mounted.current && useGlobal.getState().isAuthSessionCurrent(snapshot)) {
        setError('No se pudo guardar la opción. Revisa la conexión e intenta nuevamente.');
      }
    } finally { if (working.current === operation) working.current = null; }
  };
  const disabled = !ready || !!busy;
  return <View style={[styles.container, embedded && styles.embedded]}>
    <TouchableOpacity style={styles.control} onPress={toggle} disabled={disabled}
      accessibilityRole="switch" accessibilityLabel="Compartir borrador en vivo"
      accessibilityState={{ checked: enabled, disabled, busy: !!busy }}
      {...(Platform.OS === 'web' ? { 'aria-checked': enabled, 'aria-disabled': disabled, 'aria-busy': !!busy } : {})}>
      <Text style={styles.title}>Compartir borrador en vivo</Text>
      <View style={[styles.pill, enabled && styles.enabled]}><Text style={[styles.value, enabled && styles.enabledValue]}>{enabled ? 'Activado' : 'Desactivado'}</Text></View>
    </TouchableOpacity>
    <Text style={styles.help}>Si lo activas, tu contacto verá el texto mientras lo escribes, antes de enviarlo. El borrador desaparece al dejar de escribir y no se guarda.</Text>
    {error && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  container: { width: '100%', maxWidth: 360, marginTop: 24, padding: 16, borderRadius: 16, backgroundColor: '#FFFFFF' },
  embedded: { marginTop: 0, padding: 0, maxWidth: undefined },
  control: { minHeight: 44, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  title: { color: '#163B5D', fontSize: 16, fontWeight: '600', flexShrink: 1 },
  pill: { borderRadius: 10, backgroundColor: '#EDF5FC', paddingVertical: 8, paddingHorizontal: 10 },
  enabled: { backgroundColor: '#155EA0' },
  value: { color: '#155EA0', fontSize: 12, fontWeight: '600' },
  enabledValue: { color: '#FFFFFF' },
  help: { color: '#365C78', fontSize: 13, lineHeight: 19, marginTop: 10 },
  error: { color: '#8B2424', fontSize: 13, lineHeight: 19, marginTop: 10 },
});

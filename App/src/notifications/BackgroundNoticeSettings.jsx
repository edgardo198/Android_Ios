import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { retryBackgroundNotices, setBackgroundNoticesEnabled, useBackgroundNoticeState } from './BackgroundNotices';

export default function BackgroundNoticeSettings({ embedded = false } = {}) {
  const state = useBackgroundNoticeState();
  const disabled = !state.ready || state.changing;
  const busy = state.changing || state.loading || state.starting;
  const status = !state.enabled ? 'Desactivados' : state.connected ? 'Recibiendo avisos' : state.running
    ? 'Conectando…' : busy ? 'Activando…' : 'Activados';
  return <View style={[styles.container, embedded && styles.embedded]}>
    {state.available ? <>
      <TouchableOpacity style={styles.control} accessibilityRole="switch" accessibilityLabel="Avisos con la app cerrada"
        accessibilityState={{ checked: state.enabled, disabled, busy }} disabled={disabled}
        {...(Platform.OS === 'web' ? { 'aria-checked': state.enabled, 'aria-disabled': disabled, 'aria-busy': busy } : {})}
        onPress={() => { void setBackgroundNoticesEnabled(!state.enabled).catch(() => {}); }}>
        <Text style={styles.title}>Avisos con la app cerrada</Text>
        <View style={[styles.pill, state.enabled && styles.enabled]}>
          <Text style={[styles.value, state.enabled && styles.enabledValue]}>{state.enabled ? 'Activados' : 'Desactivados'}</Text>
        </View>
      </TouchableOpacity>
      <Text style={styles.help}>Recibe mensajes y avisos de llamadas aunque salgas de la app. Android mostrará una notificación permanente mientras estén activados.</Text>
      <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>
      {state.error && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{state.error}</Text>}
      {state.error && <TouchableOpacity style={styles.retry} accessibilityRole="button"
        accessibilityLabel="Reintentar recepción de avisos" disabled={!state.ready || busy}
        onPress={() => { void retryBackgroundNotices().catch(() => {}); }}>
        <Text style={styles.retryText}>Reintentar</Text>
      </TouchableOpacity>}
    </> : <>
      <Text style={styles.title}>Avisos con la app cerrada</Text>
      <Text style={styles.help}>{state.reason}</Text>
    </>}
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
  status: { color: '#365C78', fontSize: 12, marginTop: 8 },
  error: { color: '#8B2424', fontSize: 13, lineHeight: 19, marginTop: 10 },
  retry: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 12, marginTop: 4 },
  retryText: { color: '#155EA0', fontWeight: '600', fontSize: 13 },
});

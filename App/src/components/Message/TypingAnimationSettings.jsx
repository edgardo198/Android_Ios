import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { setTypingAnimationMode, useTypingAnimationMode } from '../../core/typingAnimation';

const OPTIONS = [['system', 'Sistema'], ['on', 'Activada'], ['off', 'Desactivada']];

export default function TypingAnimationSettings({ embedded = false } = {}) {
  const mode = useTypingAnimationMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const select = async (next) => {
    if (!mounted.current || working.current || next === mode) return;
    working.current = true;
    setBusy(true); setError(null);
    try {
      await setTypingAnimationMode(next);
    } catch {
      if (mounted.current) setError('No se pudo guardar la opción. Intenta nuevamente.');
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <View style={[styles.container, embedded && styles.embedded]}>
      <Text style={styles.title}>Animación al escribir</Text>
      <View style={styles.options}>
        {OPTIONS.map(([value, label]) => (
          <TouchableOpacity key={value} style={[styles.option, mode === value && styles.selected]} onPress={() => select(value)} disabled={busy}
            {...(Platform.OS === 'web' ? { 'aria-checked': mode === value, 'aria-busy': busy, 'aria-disabled': busy } : {})}
            accessibilityRole="radio" accessibilityLabel={`Animación al escribir: ${label}`} accessibilityState={{ checked: mode === value, disabled: busy, busy }}>
            <Text style={[styles.label, mode === value && styles.selectedLabel]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.help}>{mode === 'on' ? 'Anima los puntos aunque el sistema reduzca el movimiento.'
        : mode === 'off' ? 'Muestra los puntos sin movimiento.' : 'Sigue el ajuste de movimiento del teléfono o navegador.'}</Text>
      {error && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', maxWidth: 360, marginTop: 24, padding: 16, borderRadius: 16, backgroundColor: '#FFFFFF' },
  embedded: { marginTop: 0, padding: 0, maxWidth: undefined },
  title: { fontSize: 16, fontWeight: '600', color: '#163B5D', marginBottom: 12 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  option: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 10, backgroundColor: '#EDF5FC' },
  selected: { backgroundColor: '#155EA0' },
  label: { color: '#155EA0', fontWeight: '600', fontSize: 13 },
  selectedLabel: { color: '#FFFFFF' },
  help: { color: '#365C78', fontSize: 13, lineHeight: 19, marginTop: 12 },
  error: { color: '#8B2424', fontSize: 13, lineHeight: 19, marginTop: 10 },
});

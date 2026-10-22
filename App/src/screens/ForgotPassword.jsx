import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Input from '../common/Input';
import Button from '../common/Button';
import styles from '../Styles/styles';
import api from '../core/api';
import useGlobal from '../core/global';
import { normalizeApiError } from '../common/apiError';
import { normalizeRecoveryEmail, recoveryEmailError, RECOVERY_REQUEST_MESSAGE, recoveryExitRoute } from '../common/passwordRecovery';

export default function ForgotPasswordScreen({ navigation }) {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const pending = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const blur = navigation.addListener?.('blur', () => { pending.current?.abort(); pending.current = null; setLoading(false); });
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; blur?.(); };
  }, [navigation]);

  async function submit() {
    if (pending.current) return;
    const validation = recoveryEmailError(email);
    setEmailError(validation);
    setError('');
    setSent(false);
    if (validation) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      await api({ method: 'POST', url: '/chat/password-reset/request/', data: { email: normalizeRecoveryEmail(email) }, signal: controller.signal, timeout: 30000 });
      if (mounted.current && pending.current === controller) setSent(true);
    } catch (failure) {
      if (mounted.current && pending.current === controller) setError(failure.response
        ? normalizeApiError(failure.response.data, 'No se pudo solicitar la recuperación. Intenta nuevamente.')
        : 'No se pudo conectar con el servidor. Intenta nuevamente.');
    } finally {
      if (mounted.current && pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 20 }} keyboardShouldPersistTaps="handled">
          <View style={styles.authForm}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: '#155EA0', marginBottom: 12 }}>Recuperar contraseña</Text>
            <Text style={{ color: '#365C78', lineHeight: 21, marginBottom: 16 }}>Escribe el correo que guardaste al registrarte o en tu perfil.</Text>
            <Input title="Correo electrónico" value={email} error={emailError} setError={setEmailError}
              setValue={(value) => { setEmail(value); setError(''); setSent(false); }} keyboardType="email-address"
              autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress"
              disabled={loading} onSubmitEditing={submit} />
            {!!error && <Text style={styles.authError} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
            {sent && <Text style={{ color: '#245C36', lineHeight: 21 }} accessibilityLiveRegion="polite">{RECOVERY_REQUEST_MESSAGE}</Text>}
            <Button title={loading ? 'Enviando...' : sent ? 'Enviar nuevamente' : 'Enviar instrucciones'} onPress={submit} disabled={loading} />
            <TouchableOpacity style={styles.registerButton} accessibilityRole="button" onPress={() => navigation.navigate('ResetPassword')}>
              <Text style={styles.registerText}>Ya tengo un código de recuperación</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.registerButton} accessibilityRole="button" onPress={() => navigation.navigate(recoveryExitRoute(useGlobal.getState()))}>
              <Text style={styles.registerText}>Volver</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

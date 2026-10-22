import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Input from '../common/Input';
import Button from '../common/Button';
import styles from '../Styles/styles';
import api from '../core/api';
import useGlobal from '../core/global';
import { normalizeApiError } from '../common/apiError';
import { clearPasswordResetUrl, INVALID_RECOVERY_LINK, readPasswordResetCode, resetPasswordErrors, recoveryExitRoute, takePasswordResetLink } from '../common/passwordRecovery';

export default function ResetPasswordScreen({ navigation, route }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeatedPassword, setRepeatedPassword] = useState('');
  const [codeError, setCodeError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [repeatedError, setRepeatedError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const pending = useRef(null);
  const mounted = useRef(true);
  const passwordRef = useRef(null);
  const repeatedRef = useRef(null);
  const consumedLink = useRef(null);
  useEffect(() => {
    mounted.current = true;
    const blur = navigation.addListener?.('blur', () => {
      pending.current?.abort(); pending.current = null;
      setLoading(false); setCode(''); setPassword(''); setRepeatedPassword('');
    });
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; blur?.(); };
  }, [navigation]);
  useEffect(() => {
    const params = route?.params;
    if (!params?.requestId && !params?.uid && !params?.token) return;
    const linkIdentity = params.requestId || params;
    if (consumedLink.current === linkIdentity) return;
    consumedLink.current = linkIdentity;
    pending.current?.abort(); pending.current = null;
    const link = params.requestId ? takePasswordResetLink(params.requestId)
      : { credentials: readPasswordResetCode(`${params.uid || ''}:${params.token || ''}`) };
    setCode(link?.credentials ? `${link.credentials.uid}:${link.credentials.token}` : '');
    setError(link?.error || (!link?.credentials ? INVALID_RECOVERY_LINK : ''));
    setCodeError(''); setPasswordError(''); setRepeatedError('');
    setPassword(''); setRepeatedPassword(''); setLoading(false); setSuccess(false);
    navigation.setParams?.({ requestId: undefined, uid: undefined, token: undefined });
    if (Platform.OS === 'web') clearPasswordResetUrl(globalThis.window);
  }, [route?.params?.requestId, route?.params?.uid, route?.params?.token, navigation]);

  async function submit() {
    if (pending.current) return;
    const credentials = readPasswordResetCode(code);
    const validation = resetPasswordErrors(password, repeatedPassword);
    setCodeError(credentials ? '' : 'Pega el código completo del correo (uid:token).');
    setPasswordError(validation.password); setRepeatedError(validation.repeatedPassword); setError('');
    if (!credentials || validation.password || validation.repeatedPassword) return;
    const sessionSnapshot = useGlobal.getState().captureAuthSession();
    const controller = new AbortController();
    pending.current = controller; setLoading(true);
    try {
      const response = await api({ method: 'POST', url: '/chat/password-reset/confirm/',
        data: { ...credentials, password }, signal: controller.signal, timeout: 30000 });
      if (!mounted.current || pending.current !== controller) return;
      if (typeof response.data?.username !== 'string' || !response.data.username) throw new Error('Invalid reset response');
      await useGlobal.getState().completePasswordReset(response.data.username, sessionSnapshot);
      if (mounted.current && pending.current === controller) {
        setSuccess(true); setCode(''); setPassword(''); setRepeatedPassword('');
      }
    } catch (failure) {
      if (mounted.current && pending.current === controller) setError(failure.response
        ? normalizeApiError(failure.response.data, INVALID_RECOVERY_LINK)
        : 'No se pudo completar el cambio. Intenta nuevamente.');
    } finally {
      if (mounted.current && pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }

  const authenticated = useGlobal((state) => state.authenticated);
  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 20 }} keyboardShouldPersistTaps="handled">
          <View style={styles.authForm}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: '#155EA0', marginBottom: 12 }}>Nueva contraseña</Text>
            {success ? <>
              <Text style={{ color: '#245C36', lineHeight: 21 }} accessibilityLiveRegion="polite">Contraseña actualizada. Inicia sesión nuevamente en la cuenta recuperada.</Text>
              <Button title={authenticated ? 'Volver a mi cuenta' : 'Ir al inicio de sesión'} onPress={() => navigation.navigate(recoveryExitRoute(useGlobal.getState()))} />
            </> : <>
              <Text style={{ color: '#365C78', lineHeight: 21, marginBottom: 16 }}>Abre el enlace del correo o pega su código de recuperación. Usa una contraseña de al menos 8 caracteres.</Text>
              <Input title="Código de recuperación" value={code} error={codeError} setError={setCodeError}
                setValue={(value) => { setCode(value); setError(''); }} secureTextEntry autoCapitalize="none" autoCorrect={false}
                autoComplete="off" disabled={loading} returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} />
              <Input title="Nueva contraseña" value={password} error={passwordError} setError={setPasswordError}
                setValue={(value) => { setPassword(value); setError(''); }} secureTextEntry autoCapitalize="none" autoCorrect={false}
                autoComplete="new-password" textContentType="newPassword" disabled={loading} inputRef={passwordRef}
                returnKeyType="next" onSubmitEditing={() => repeatedRef.current?.focus()} />
              <Input title="Repetir contraseña" value={repeatedPassword} error={repeatedError} setError={setRepeatedError}
                setValue={(value) => { setRepeatedPassword(value); setError(''); }} secureTextEntry autoCapitalize="none" autoCorrect={false}
                autoComplete="new-password" textContentType="newPassword" disabled={loading} inputRef={repeatedRef} onSubmitEditing={submit} />
              {!!error && <Text style={styles.authError} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
              <Button title={loading ? 'Actualizando...' : 'Guardar contraseña'} onPress={submit} disabled={loading} />
              <TouchableOpacity style={styles.registerButton} accessibilityRole="button" onPress={() => navigation.navigate('ForgotPassword')}>
                <Text style={styles.registerText}>Solicitar otro código</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.registerButton} accessibilityRole="button" onPress={() => navigation.navigate(recoveryExitRoute(useGlobal.getState()))}>
                <Text style={styles.registerText}>Volver</Text>
              </TouchableOpacity>
            </>}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

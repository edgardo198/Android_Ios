import React, { useLayoutEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFonts } from 'expo-font';
import { SafeAreaView } from 'react-native-safe-area-context';
import Title from '../common/Title';
import Button from '../common/Button';
import DismissKeyboardView from '../common/DismissKeyboardView';
import Input from '../common/Input';
import styles from '../Styles/styles';
import api from '../core/api';
import { normalizeApiError } from '../common/apiError';
import useGlobal from '../core/global';

function SignInScreen({ navigation }) {
  const [usuario, setUsuario] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [usuarioError, setUsuarioError] = useState('');
  const [contrasenaError, setContrasenaError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const login = useGlobal((state) => state.login);
  const passwordRef = useRef(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: false,
    });
  }, [navigation]);

  const [fontsLoaded] = useFonts({
    'IBMPlexSans-Bold': require('../assets/fonts/IBMPlexSans-Bold.ttf'),
  });

  async function onSignIn() {
    setSubmitError('');
    const normalizedUsuario = usuario.trim();
    let hasError = false;

    if (!normalizedUsuario) {
      setUsuarioError('Ingresa un usuario valido');
      hasError = true;
    }

    if (!contrasena) {
      setContrasenaError('Ingresa una contrasena');
      hasError = true;
    }

    if (hasError || isLoading) {
      return;
    }

    setIsLoading(true);

    try {
      const response = await api({
        method: 'POST',
        url: '/chat/signin/',
        data: {
          username: normalizedUsuario,
          password: contrasena,
        },
      });

      await login(
        {
          username: normalizedUsuario,
          password: contrasena,
        },
        response.data.user,
        response.data.tokens
      );
    } catch (error) {
      const message = error.response
        ? normalizeApiError(error.response.data)
        : 'No se pudo conectar con el servidor. Verifica que el backend este encendido.';

      setSubmitError(message);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <DismissKeyboardView style={styles.innerContainer}>
          <ScrollView style={{ flex: 1, width: '100%' }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={styles.authForm}>
            <View style={styles.authTitleContainer}>
              <Title fontLoaded={fontsLoaded} />
            </View>
            <Input
              title="Usuario"
              value={usuario}
              error={usuarioError}
              setValue={(value) => { setUsuario(value); setSubmitError(''); }}
              setError={setUsuarioError}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              textContentType="username"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              blurOnSubmit={false}
              autoFocus
            />
            <Input
              title="Contrasena"
              value={contrasena}
              error={contrasenaError}
              setValue={(value) => { setContrasena(value); setSubmitError(''); }}
              setError={setContrasenaError}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="done"
              onSubmitEditing={onSignIn}
              inputRef={passwordRef}
            />
            {!!submitError && (
              <Text style={styles.authError} accessibilityRole="alert" accessibilityLiveRegion="polite">
                {submitError}
              </Text>
            )}
            <Button
              title={isLoading ? 'Ingresando...' : 'Ingresar'}
              onPress={onSignIn}
              disabled={isLoading}
            />
            <TouchableOpacity
              onPress={() => navigation.navigate('ForgotPassword')}
              style={styles.registerButton}
              accessibilityRole="button"
              accessibilityLabel="Olvidé mi contraseña"
            >
              <Text style={styles.registerText}>Olvidé mi contraseña</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => navigation.navigate('SignUp')}
              style={styles.registerButton}
            >
              <Text style={styles.registerText}>No tienes cuenta? Registrate</Text>
            </TouchableOpacity>
          </View>
          </ScrollView>
        </DismissKeyboardView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default SignInScreen;

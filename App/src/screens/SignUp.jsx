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
import WebBackButton from '../common/WebBackButton';
import styles from '../Styles/styles';
import api from '../core/api';
import { connectionErrorMessage, normalizeApiError } from '../common/apiError';
import useGlobal from '../core/global';
import { normalizeRecoveryEmail, recoveryEmailError } from '../common/passwordRecovery';

function SignUpScreen({ navigation }) {
  const [usuario, setUsuario] = useState('');
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [email, setEmail] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [confirmarContrasena, setConfirmarContrasena] = useState('');

  const [usuarioError, setUsuarioError] = useState('');
  const [nombreError, setNombreError] = useState('');
  const [apellidoError, setApellidoError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [contrasenaError, setContrasenaError] = useState('');
  const [confirmarContrasenaError, setConfirmarContrasenaError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const login = useGlobal((state) => state.login);
  const nombreRef = useRef(null);
  const apellidoRef = useRef(null);
  const contrasenaRef = useRef(null);
  const emailRef = useRef(null);
  const confirmarRef = useRef(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: false,
    });
  }, [navigation]);

  const [fontsLoaded] = useFonts({
    'IBMPlexSans-Bold': require('../assets/fonts/IBMPlexSans-Bold.ttf'),
  });

  async function onSignUp() {
    setSubmitError('');
    let isValid = true;

    const normalizedUsuario = usuario.trim();
    const normalizedNombre = nombre.trim();
    const normalizedApellido = apellido.trim();
    const emailValidation = recoveryEmailError(email);
    setEmailError(emailValidation);
    if (emailValidation) isValid = false;

    if (!normalizedUsuario) {
      setUsuarioError('Ingresa un usuario valido');
      isValid = false;
    }

    if (!normalizedNombre) {
      setNombreError('Ingresa un nombre valido');
      isValid = false;
    }

    if (!normalizedApellido) {
      setApellidoError('Ingresa un apellido valido');
      isValid = false;
    }

    if (!contrasena) {
      setContrasenaError('Ingresa una contrasena valida');
      isValid = false;
    } else if (contrasena.length < 8) {
      setContrasenaError('Usa al menos 8 caracteres');
      isValid = false;
    }

    if (!confirmarContrasena) {
      setConfirmarContrasenaError('Confirma la contrasena');
      isValid = false;
    } else if (contrasena !== confirmarContrasena) {
      setConfirmarContrasenaError('Las contrasenas no coinciden');
      isValid = false;
    }

    if (!isValid || isLoading) {
      return;
    }

    setIsLoading(true);

    try {
      const response = await api({
        method: 'POST',
        url: '/chat/signup/',
        data: {
          username: normalizedUsuario,
          first_name: normalizedNombre,
          last_name: normalizedApellido,
          email: normalizeRecoveryEmail(email),
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
        : connectionErrorMessage(error);

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
            <WebBackButton navigation={navigation} fallbackRoute="SignIn" style={styles.authBackButton} />
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
              onSubmitEditing={() => nombreRef.current?.focus()}
              blurOnSubmit={false}
              autoFocus
            />
            <Input
              title="Nombre"
              value={nombre}
              error={nombreError}
              setValue={(value) => { setNombre(value); setSubmitError(''); }}
              setError={setNombreError}
              autoCapitalize="words"
              autoCorrect={false}
              autoComplete="name-given"
              textContentType="givenName"
              returnKeyType="next"
              onSubmitEditing={() => apellidoRef.current?.focus()}
              blurOnSubmit={false}
              inputRef={nombreRef}
            />
            <Input
              title="Apellido"
              value={apellido}
              error={apellidoError}
              setValue={(value) => { setApellido(value); setSubmitError(''); }}
              setError={setApellidoError}
              autoCapitalize="words"
              autoCorrect={false}
              autoComplete="name-family"
              textContentType="familyName"
              returnKeyType="next"
              onSubmitEditing={() => emailRef.current?.focus()}
              blurOnSubmit={false}
              inputRef={apellidoRef}
            />
            <Input
              title="Correo electrónico"
              value={email}
              error={emailError}
              setValue={(value) => { setEmail(value); setSubmitError(''); }}
              setError={setEmailError}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              onSubmitEditing={() => contrasenaRef.current?.focus()}
              blurOnSubmit={false}
              inputRef={emailRef}
            />
            <Text style={{ color: '#365C78', marginBottom: 12 }}>Usaremos este correo para recuperar tu contraseña.</Text>
            <Input
              title="Contrasena"
              value={contrasena}
              error={contrasenaError}
              setValue={(value) => { setContrasena(value); setSubmitError(''); }}
              setError={setContrasenaError}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="newPassword"
              returnKeyType="next"
              onSubmitEditing={() => confirmarRef.current?.focus()}
              blurOnSubmit={false}
              inputRef={contrasenaRef}
            />
            <Input
              title="Confirmar Contrasena"
              value={confirmarContrasena}
              error={confirmarContrasenaError}
              setValue={(value) => { setConfirmarContrasena(value); setSubmitError(''); }}
              setError={setConfirmarContrasenaError}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="password"
              returnKeyType="done"
              onSubmitEditing={onSignUp}
              inputRef={confirmarRef}
            />
            {!!submitError && (
              <Text style={styles.authError} accessibilityRole="alert" accessibilityLiveRegion="polite">
                {submitError}
              </Text>
            )}
            <Button
              title={isLoading ? 'Registrando...' : 'Registrarse'}
              onPress={onSignUp}
              disabled={isLoading}
            />
            <TouchableOpacity
              onPress={() => navigation.popTo('SignIn')}
              style={styles.registerButton}
            >
              <Text style={styles.registerText}>Ya tienes cuenta? Inicia sesion</Text>
            </TouchableOpacity>
          </View>
          </ScrollView>
        </DismissKeyboardView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default SignUpScreen;

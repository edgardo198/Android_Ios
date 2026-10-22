import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Alert, Platform, ScrollView, StyleSheet } from 'react-native';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faPen, faSignOutAlt, faCamera, faImages, faChevronRight, faChevronUp, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import useGlobal from '../core/global';
import Miniatura from '../common/Miniatura';
import styles from '../Styles/styles';
import Input from '../common/Input';
import Button from '../common/Button';
import { normalizeApiError } from '../common/apiError';
import { normalizeRecoveryEmail, recoveryEmailError } from '../common/passwordRecovery';
import TypingAnimationSettings from '../components/Message/TypingAnimationSettings';
import LiveTypingSettings from '../components/Message/LiveTypingSettings';
import BackgroundNoticeSettings from '../notifications/BackgroundNoticeSettings';

function ProfileImage() {
  const uploadMiniatura = useGlobal((state) => state.uploadMiniatura);
  const user = useGlobal((state) => state.user);
  const [isModalVisible, setModalVisible] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const busyRef = useRef(false);
  const pendingCameraRef = useRef(null);
  const socketConnected = useGlobal((state) => state.socketConnected);

  const closeAndPick = (fromCamera) => {
    if (Platform.OS === 'ios') {
      pendingCameraRef.current = fromCamera;
      setModalVisible(false);
    } else {
      void pickImage(fromCamera);
    }
  };

  const pickImage = async (fromCamera = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsBusy(true);
    setModalVisible(false);
    try {
      if (!socketConnected) {
        Alert.alert('Sin conexión', 'Espera a que se restablezca la conexión para cambiar tu foto.');
        return;
      }
      if (fromCamera && Platform.OS === 'web') {
        Alert.alert(
          'No disponible en navegador',
          'La captura directa con camara sigue pensada para la app movil.'
        );
        return;
      }

      const permissionResult = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : null;
      if (permissionResult && !permissionResult.granted) {
        Alert.alert(
          'Permiso requerido',
          `Se necesita permiso para acceder a tu ${fromCamera ? 'camara' : 'galeria de fotos'}.`
        );
        return;
      }

      const result = fromCamera
        ? await ImagePicker.launchCameraAsync({
            allowsEditing: true,
            aspect: [1, 1],
            quality: 1,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 1,
          });

      if (!result.canceled && result.assets?.[0]) {
        const context = ImageManipulator.manipulate(result.assets[0].uri);
        let image;
        try {
          context.resize({ width: 512 });
          image = await context.renderAsync();
          const thumbnail = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
          if (!thumbnail.base64) throw new Error('No se pudo leer la imagen.');
          const sent = await uploadMiniatura({ base64: thumbnail.base64, fileName: `perfil-${Date.now()}.jpg` });
          if (sent === false) Alert.alert('Sin conexión', 'No se pudo enviar la foto. Intenta nuevamente.');
        } finally {
          image?.release();
          context.release();
        }
      }
    } catch (error) {
      Alert.alert('Error', 'No se pudo procesar la imagen. Por favor, intenta de nuevo.');
    } finally {
      busyRef.current = false;
      setIsBusy(false);
      setModalVisible(false);
    }
  };

  return (
    <View style={profileStyles.photoContainer}>
      <TouchableOpacity onPress={() => setModalVisible(true)} disabled={isBusy}
        accessibilityRole="button" accessibilityLabel="Cambiar foto de perfil"
        accessibilityHint={Platform.OS === 'web' ? 'Elige una imagen de tus archivos.' : 'Elige una foto de la galería o usa la cámara.'}
        accessibilityState={{ disabled: isBusy, busy: isBusy }}>
        <View style={profileStyles.photo}>
          <Miniatura url={user?.miniatura} size={76} />
          <View style={profileStyles.editPhoto}>
            <FontAwesomeIcon icon={faPen} size={11} color="#ffffff" />
          </View>
        </View>
        <Text style={profileStyles.photoCaption}>{isBusy ? 'Actualizando...' : 'Cambiar foto'}</Text>
      </TouchableOpacity>
      <Modal
        transparent
        animationType="fade"
        visible={isModalVisible}
        onRequestClose={() => setModalVisible(false)}
        onDismiss={() => {
          const fromCamera = pendingCameraRef.current;
          if (fromCamera !== null) {
            pendingCameraRef.current = null;
            void pickImage(fromCamera);
          }
        }}
      >
        <View style={styles.modalBackground}>
          <View style={profileStyles.photoModal}>
            <Text style={profileStyles.sectionTitle} accessibilityRole="header">Foto de perfil</Text>
            <TouchableOpacity style={profileStyles.photoOption} onPress={() => closeAndPick(false)} accessibilityRole="button">
              <FontAwesomeIcon icon={faImages} size={20} color="#0078d4" />
              <Text style={profileStyles.photoOptionText}>
                {Platform.OS === 'web' ? 'Seleccionar archivo' : 'Galería'}
              </Text>
            </TouchableOpacity>
            {Platform.OS !== 'web' && (
              <TouchableOpacity style={profileStyles.photoOption} onPress={() => closeAndPick(true)} accessibilityRole="button">
                <FontAwesomeIcon icon={faCamera} size={20} color="#0078d4" />
                <Text style={profileStyles.photoOptionText}>Cámara</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={profileStyles.photoOption} onPress={() => setModalVisible(false)} accessibilityRole="button">
              <Text style={profileStyles.photoOptionText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ProfileLogout() {
  const logout = useGlobal((state) => state.logout);

  return (
    <TouchableOpacity onPress={logout} style={profileStyles.logoutButton}
      accessibilityRole="button" accessibilityLabel="Cerrar sesión">
      <FontAwesomeIcon icon={faSignOutAlt} size={18} color="#B42318" />
      <Text style={profileStyles.logoutText}>Cerrar sesión</Text>
    </TouchableOpacity>
  );
}

export function ProfileEmail({ navigation }) {
  const user = useGlobal((state) => state.user);
  const updateEmail = useGlobal((state) => state.updateEmail);
  const [email, setEmail] = useState(user?.email || '');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const mounted = useRef(true);
  const operation = useRef(null);
  const identity = useRef(user?.username);
  const edited = useRef(false);
  const focused = useRef(true);
  const formGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const blur = navigation?.addListener?.('blur', () => { focused.current = false; formGeneration.current++; setPassword(''); setError(''); setSaved(false); });
    const focus = navigation?.addListener?.('focus', () => { focused.current = true; });
    const unsubscribe = useGlobal.subscribe?.((next, previous) => {
      if (next.authenticated !== previous.authenticated || next.user?.username !== previous.user?.username) {
        operation.current = null; edited.current = false;
        formGeneration.current++;
        setPassword(''); setError(''); setSaved(false); setLoading(false); setExpanded(false);
        setEmailError(''); setPasswordError(''); setEmail(next.user?.email || '');
      }
    });
    return () => { mounted.current = false; operation.current = null; blur?.(); focus?.(); unsubscribe?.(); };
  }, [navigation]);
  useEffect(() => {
    if (identity.current !== user?.username) {
      identity.current = user?.username; operation.current = null; edited.current = false;
      formGeneration.current++;
      setPassword(''); setError(''); setSaved(false); setLoading(false); setExpanded(false);
      setEmailError(''); setPasswordError('');
    }
    if (!edited.current) setEmail(user?.email || '');
  }, [user?.username, user?.email]);

  function toggleForm() {
    formGeneration.current++;
    edited.current = false;
    setEmail(user?.email || ''); setPassword(''); setEmailError(''); setPasswordError(''); setError(''); setSaved(false);
    setExpanded((current) => !current);
  }

  async function save() {
    if (operation.current) return;
    const validation = recoveryEmailError(email);
    setEmailError(validation); setPasswordError(password ? '' : 'Ingresa tu contraseña actual.'); setError(''); setSaved(false);
    if (validation || !password) return;
    const snapshot = useGlobal.getState().captureAuthSession();
    const generation = formGeneration.current;
    const attempt = {};
    operation.current = attempt; setLoading(true);
    try {
      await updateEmail(normalizeRecoveryEmail(email), password);
      if (mounted.current && focused.current && operation.current === attempt && formGeneration.current === generation && useGlobal.getState().isAuthSessionCurrent(snapshot)) {
        edited.current = false; setPassword(''); setSaved(true);
      }
    } catch (failure) {
      if (mounted.current && focused.current && operation.current === attempt && formGeneration.current === generation && useGlobal.getState().isAuthSessionCurrent(snapshot)) {
        setError(failure.response ? normalizeApiError(failure.response.data) : 'No se pudo guardar el correo. Intenta nuevamente.');
      }
    } finally {
      if (mounted.current && operation.current === attempt) { operation.current = null; setLoading(false); }
    }
  }

  return (
    <View>
      <Text style={profileStyles.settingLabel}>Correo de recuperación</Text>
      <Text style={[profileStyles.emailSummary, profileStyles.wrappingText]}>{user?.email || 'No has guardado un correo.'}</Text>
      <Text style={profileStyles.help}>Úsalo para recuperar tu cuenta si olvidas la contraseña.</Text>
      <TouchableOpacity onPress={toggleForm} style={profileStyles.emailToggle}
        accessibilityRole="button" accessibilityState={{ expanded }}
        {...(Platform.OS === 'web' ? { 'aria-expanded': expanded } : {})}
        accessibilityLabel={expanded ? 'Cerrar formulario de correo' : user?.email ? 'Cambiar correo de recuperación' : 'Añadir correo de recuperación'}>
        <Text style={profileStyles.emailToggleText}>{expanded ? 'Cerrar formulario' : user?.email ? 'Cambiar correo' : 'Añadir correo'}</Text>
        <FontAwesomeIcon icon={expanded ? faChevronUp : faChevronDown} size={12} color="#155EA0" />
      </TouchableOpacity>
      {loading && !expanded && <Text style={profileStyles.help} accessibilityLiveRegion="polite">El cambio de correo sigue en proceso.</Text>}
      {expanded && <View style={profileStyles.emailForm}>
        <Text style={profileStyles.help}>Escribe el correo y tu contraseña actual para confirmar el cambio.</Text>
        <Input title="Correo electrónico" labelStyle={profileStyles.inputLabel} inputStyle={profileStyles.emailInput} value={email} error={emailError} setError={setEmailError}
          setValue={(value) => { edited.current = true; setEmail(value); setError(''); setSaved(false); }}
          keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress" disabled={loading} />
        <Input title="Contraseña actual" labelStyle={profileStyles.inputLabel} inputStyle={profileStyles.emailInput} value={password} error={passwordError} setError={setPasswordError}
          setValue={(value) => { setPassword(value); setError(''); setSaved(false); }} secureTextEntry autoCapitalize="none"
          autoCorrect={false} autoComplete="current-password" textContentType="password" disabled={loading} onSubmitEditing={save} />
        {!!error && <Text style={styles.authError} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
        {saved && <Text style={profileStyles.savedMessage} accessibilityLiveRegion="polite">Correo guardado.</Text>}
        <Button title={loading ? 'Guardando...' : 'Guardar correo'} onPress={save} disabled={loading} style={profileStyles.saveButton} />
      </View>}
    </View>
  );
}

function ProfileScreen({ navigation }) {
  const user = useGlobal((state) => state.user);

  return (
    <ScrollView style={profileStyles.page} contentContainerStyle={profileStyles.content} keyboardShouldPersistTaps="handled">
      <View style={profileStyles.panel}>
        <View style={profileStyles.card}>
          <Text style={profileStyles.sectionTitle} accessibilityRole="header">Cuenta</Text>
          <View style={profileStyles.accountRow}>
            <ProfileImage />
            <View style={profileStyles.accountDetails}>
              <Text style={[profileStyles.name, profileStyles.wrappingText]}>{user?.name || 'Usuario'}</Text>
              <Text style={[profileStyles.username, profileStyles.wrappingText]}>{user?.username || 'Sin nombre de usuario'}</Text>
            </View>
          </View>
        </View>
        <View style={profileStyles.card}>
          <Text style={profileStyles.sectionTitle} accessibilityRole="header">Seguridad</Text>
          <ProfileEmail navigation={navigation} />
        </View>
        <View style={profileStyles.card}>
          <Text style={profileStyles.sectionTitle} accessibilityRole="header">Conversación</Text>
          <LiveTypingSettings embedded />
          <View style={profileStyles.settingDivider} />
          <TypingAnimationSettings embedded />
          <View style={profileStyles.settingDivider} />
          <BackgroundNoticeSettings embedded />
        </View>
        <View style={profileStyles.card}>
          <Text style={profileStyles.sectionTitle} accessibilityRole="header">Llamadas</Text>
          <TouchableOpacity style={profileStyles.navigationRow} onPress={() => navigation.navigate('CallHistory')}
            accessibilityRole="button" accessibilityLabel="Historial de llamadas">
            <View style={profileStyles.navigationCopy}>
              <Text style={profileStyles.navigationTitle}>Historial de llamadas</Text>
              <Text style={profileStyles.help}>Revisa las llamadas recibidas y realizadas.</Text>
            </View>
            <FontAwesomeIcon icon={faChevronRight} size={13} color="#547189" />
          </TouchableOpacity>
          <View style={profileStyles.divider} />
          <TouchableOpacity style={profileStyles.navigationRow} onPress={() => navigation.navigate('CallDiagnostics')}
            accessibilityRole="button" accessibilityLabel="Prueba de llamadas">
            <View style={profileStyles.navigationCopy}>
              <Text style={profileStyles.navigationTitle}>Prueba de llamadas</Text>
              <Text style={profileStyles.help}>Comprueba los permisos de audio y la vista de cámara.</Text>
            </View>
            <FontAwesomeIcon icon={faChevronRight} size={13} color="#547189" />
          </TouchableOpacity>
        </View>
        <View style={profileStyles.card}>
          <Text style={profileStyles.sectionTitle} accessibilityRole="header">Sesión</Text>
          <Text style={profileStyles.help}>Cierra tu sesión en este dispositivo.</Text>
          <ProfileLogout />
        </View>
      </View>
    </ScrollView>
  );
}

const profileStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#EDF5FC' },
  content: { alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 28 },
  panel: { width: '100%', maxWidth: 560, gap: 12 },
  card: { backgroundColor: '#FFFFFF', padding: 16, borderRadius: 16, borderWidth: 1, borderColor: '#DDE9F3' },
  sectionTitle: { color: '#173F60', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  accountDetails: { flex: 1, minWidth: 0, gap: 4 },
  name: { color: '#173F60', fontSize: 21, fontWeight: '700' },
  username: { color: '#547189', fontSize: 14 },
  wrappingText: Platform.OS === 'web' ? { overflowWrap: 'anywhere' } : {},
  photoContainer: { width: 76, flexShrink: 0 },
  photo: { width: 76, height: 76 },
  editPhoto: { position: 'absolute', bottom: 0, right: 0, backgroundColor: '#155EA0', borderRadius: 14, padding: 7, borderWidth: 2, borderColor: '#FFFFFF' },
  photoCaption: { color: '#155EA0', fontSize: 12, fontWeight: '600', textAlign: 'center', marginTop: 7 },
  photoModal: { width: '90%', maxWidth: 360, backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20 },
  photoOption: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingVertical: 12, gap: 12 },
  photoOptionText: { color: '#155EA0', fontSize: 17, flexShrink: 1 },
  settingLabel: { color: '#173F60', fontSize: 15, fontWeight: '600' },
  emailSummary: { color: '#365C78', fontSize: 15, marginTop: 6, marginBottom: 4 },
  help: { color: '#547189', fontSize: 14, lineHeight: 21 },
  emailToggle: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingVertical: 10, marginTop: 6 },
  emailToggleText: { color: '#155EA0', fontSize: 14, fontWeight: '600', flexShrink: 1 },
  emailForm: { backgroundColor: '#EDF5FC', borderRadius: 12, padding: 12, marginTop: 8 },
  inputLabel: { color: '#173F60', paddingLeft: 4 },
  emailInput: { height: 'auto', minHeight: 52, paddingVertical: 12 },
  savedMessage: { color: '#245C36', fontSize: 14 },
  saveButton: { height: 'auto', minHeight: 48, paddingVertical: 12, marginTop: 12, borderRadius: 12 },
  navigationRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 8 },
  navigationCopy: { flex: 1, minWidth: 0, gap: 4 },
  navigationTitle: { color: '#173F60', fontSize: 15, fontWeight: '600' },
  divider: { height: 1, backgroundColor: '#EDF2F7', marginVertical: 6 },
  settingDivider: { height: 1, backgroundColor: '#EDF2F7', marginVertical: 16 },
  logoutButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 48, paddingVertical: 12, paddingHorizontal: 14,
    backgroundColor: '#FFF4F2', borderWidth: 1, borderColor: '#F3D5D1', borderRadius: 12, marginTop: 12 },
  logoutText: { color: '#B42318', fontSize: 15, fontWeight: '600', flexShrink: 1 },
});

export default ProfileScreen;

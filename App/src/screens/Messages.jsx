import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState, View, FlatList, Keyboard, Text, StyleSheet, KeyboardAvoidingView, Platform, TouchableOpacity } from 'react-native';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faPhone, faVideo } from '@fortawesome/free-solid-svg-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import MessageInput from '../components/Message/MessageInput';
import MessageBubble from '../components/Message/MessageBubble';
import AttachmentPreview from '../components/Message/AttachmentPreview';
import ContactProfile from '../components/Message/ContactProfile';
import MessageTypingIndicator from '../components/Message/MessageTypingIndicator';
import useMessageMedia from '../components/Message/useMessageMedia';
import WebBackButton from '../common/WebBackButton';
import DeleteConfirmation from '../common/DeleteConfirmation';
import { normalizeApiError } from '../common/apiError';
import useGlobal from '../core/global';
import { mergeMessages } from '../core/messages';
import { createTypingController } from '../core/typing';
import Miniatura from '../common/Miniatura';
import { useCalls } from '../calls/CallsProvider';

const MessagesScreen = ({ navigation, route }) => {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const flatListRef = useRef(null);
  const sendInFlight = useRef(false);
  const mountedRef = useRef(true);
  const screenSession = useRef({ active: false, generation: 0 });
  const connectionId = route?.params?.id;
  const routeFriend = route?.params?.friend;
  const friendList = useGlobal((state) => state.friendList);
  const friend = useMemo(() => {
    const latest = (Array.isArray(friendList) ? friendList : []).find((item) =>
      String(item.id) === String(connectionId) && item.friend?.username === routeFriend?.username &&
      (routeFriend?.id == null || item.friend.id == null || String(item.friend.id) === String(routeFriend.id)));
    return latest ? { ...routeFriend, ...latest.friend, username: routeFriend.username,
      ...(routeFriend.id != null ? { id: routeFriend.id } : {}) } : routeFriend;
  }, [connectionId, friendList, routeFriend]);
  const routeIdentity = useRef(null);
  routeIdentity.current = { connectionId, username: routeFriend?.username };
  const [profile, setProfile] = useState(null);
  const profileContext = useRef(null);
  const profileAction = useRef(null);
  const closeProfile = useCallback(() => {
    profileContext.current = null;
    profileAction.current = null;
    setProfile(null);
  }, []);
  const currentProfile = useCallback((context) => {
    const state = useGlobal.getState();
    return !!context && profileContext.current === context && mountedRef.current && screenSession.current.active &&
      screenSession.current.generation === context.generation && state.authenticated &&
      state.user?.username === context.username && String(routeIdentity.current.connectionId) === String(context.connectionId) &&
      routeIdentity.current.username === context.friendUsername;
  }, []);
  const messagesList = useGlobal((state) => state.messagesList);
  const pendingMessages = useGlobal((state) => state.pendingMessages);
  const messageList = useGlobal((state) => state.messageList);
  const messageSend = useGlobal((state) => state.messageSend);
  const retryPendingMessage = useGlobal((state) => state.retryPendingMessage);
  const discardPendingMessage = useGlobal((state) => state.discardPendingMessage);
  const messageType = useGlobal((state) => state.messageType);
  const messagesTyping = useGlobal((state) => state.messagesTyping);
  const clearMessages = useGlobal((state) => state.clearMessages);
  const openMessagesThread = useGlobal((state) => state.openMessagesThread);
  const socketConnected = useGlobal((state) => state.socketConnected);
  const authenticated = useGlobal((state) => state.authenticated);
  const clearConversation = useGlobal((state) => state.clearConversation);
  const conversationClearing = useGlobal((state) => !!state.conversationClearing?.[connectionId]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [historyNotice, setHistoryNotice] = useState(null);
  const deletion = useRef(null);
  const calls = useCalls();
  const [callStartError, setCallStartError] = useState(null);
  const callStartRef = useRef(false);
  const visibleMessages = useMemo(() => {
    const confirmed = Array.isArray(messagesList) ? messagesList : [];
    const confirmedClientIds = new Set(confirmed
      .filter((item) => item.is_me === true && typeof item.clientId === 'string' && item.clientId)
      .map((item) => item.clientId.toLowerCase()));
    const pending = (Array.isArray(pendingMessages) ? pendingMessages : []).filter((item) =>
      String(item.connectionId) === String(connectionId) && !confirmedClientIds.has(String(item.clientId || '').toLowerCase()));
    return mergeMessages(confirmed, pending);
  }, [connectionId, messagesList, pendingMessages]);

  const scrollToLatest = useCallback(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);
  const media = useMessageMedia(connectionId, scrollToLatest);
  const currentCall = calls.call && calls.call.status !== 'ended';
  const callUnavailable = !calls.availability?.available;
  const clearing = conversationClearing || deleteBusy;
  const callDisabled = callUnavailable || !calls.connected || !!currentCall || media.isBusy || media.isRecording || !connectionId || clearing;
  const callNotice = callStartError || (callUnavailable ? calls.availability?.reason || 'Las llamadas no están disponibles en esta versión de la app.'
    : media.isBusy || media.isRecording ? 'Termina la grabación o el envío de archivos antes de llamar.'
      : clearing ? 'Espera a que termine el borrado.'
        : currentCall ? 'Ya hay una llamada en curso.'
          : !calls.connected ? 'Las llamadas estarán disponibles cuando vuelva la conexión.' : null);
  const deleteDisabled = clearing || media.isBusy || media.isRecording || !connectionId || !authenticated;
  const onCall = async (kind) => {
    if (callDisabled || deletion.current || useGlobal.getState().conversationClearing?.[connectionId] || callStartRef.current || !screenSession.current.active) return false;
    const generation = screenSession.current.generation;
    callStartRef.current = true;
    typing.stop();
    setCallStartError(null);
    try {
      return await calls.startCall(connectionId, kind, friend);
    } catch {
      if (mountedRef.current && screenSession.current.active && screenSession.current.generation === generation) {
        setCallStartError('No se pudo iniciar la llamada. Revisa la conexión e intenta nuevamente.');
      }
      return false;
    } finally { callStartRef.current = false; }
  };
  const typing = useMemo(() => createTypingController((isTyping, draft) => {
    if (!mountedRef.current || !screenSession.current.active) return false;
    return messageType(connectionId, isTyping, draft);
  }, { getDraft: (text) => {
    const state = useGlobal.getState();
    return state.authenticated && state.outboxIdentityVerified && !state.liveTypingUpdating && state.user?.liveTypingEnabled === true ? text : null;
  } }), [connectionId, messageType]);

  useFocusEffect(useCallback(() => {
    screenSession.current = { active: true, generation: screenSession.current.generation + 1 };
    clearMessages();
    openMessagesThread(friend?.username, connectionId);
    return () => {
      typing.stop();
      screenSession.current = { active: false, generation: screenSession.current.generation + 1 };
      deletion.current = null;
      closeProfile();
      setDeleteTarget(null); setDeleteBusy(false); setDeleteError(null);
      clearMessages();
    };
  }, [clearMessages, closeProfile, connectionId, typing, friend?.username, openMessagesThread]));

  useFocusEffect(useCallback(() => {
    if (connectionId && socketConnected) messageList(connectionId);
  }, [connectionId, messageList, socketConnected]));

  const typingBlocked = !authenticated || !socketConnected || media.isBusy || media.isRecording || clearing || !!currentCall;
  useEffect(() => { if (typingBlocked) typing.stop(); }, [typing, typingBlocked]);
  useEffect(() => { if (!message.trim()) typing.stop(); }, [message, typing]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state !== 'active') typing.stop(); });
    return () => subscription.remove();
  }, [typing]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { setMessage(''); setSendError(null); setCallStartError(null); setDeleteTarget(null); setDeleteError(null); setHistoryNotice(null); closeProfile(); }, [closeProfile, connectionId]);
  useEffect(() => { if (currentCall) closeProfile(); }, [closeProfile, currentCall]);
  useEffect(() => useGlobal.subscribe((state, previous) => {
    const accountChanged = state.authenticated !== previous.authenticated || state.user?.username !== previous.user?.username;
    const historyChanged = (state.conversationHistory?.[connectionId]?.revision || 0) !== (previous.conversationHistory?.[connectionId]?.revision || 0);
    const sharingChanged = state.user?.liveTypingEnabled !== previous.user?.liveTypingEnabled ||
      state.user?.liveTypingRevision !== previous.user?.liveTypingRevision || state.liveTypingUpdating !== previous.liveTypingUpdating;
    if (sharingChanged) typing.stop();
    if (!accountChanged && !historyChanged) return;
    typing.stop();
    screenSession.current = { ...screenSession.current, generation: screenSession.current.generation + 1 };
    deletion.current = null;
    closeProfile();
    setDeleteBusy(false); setDeleteTarget(null); setDeleteError(null);
    setMessage(''); setSendError(null); setCallStartError(null);
    setHistoryNotice(historyChanged && !accountChanged ? 'La conversación se borró para ambos. Se descartó el contenido sin enviar.' : null);
  }), [closeProfile, connectionId, typing]);
  useLayoutEffect(() => navigation.setOptions({
    headerShown: false,
    // Keep the web scene within the viewport so the message input stays visible.
    ...(Platform.OS === 'web' ? { contentStyle: styles.webContent } : {}),
  }), [navigation]);

  const onType = useCallback((text) => {
    setMessage(text);
    setSendError(null);
    setHistoryNotice(null);
    if (typingBlocked) typing.stop();
    else typing.change(text);
  }, [typing, typingBlocked]);

  const onSendMessage = useCallback(async () => {
    const submitted = message;
    const trimmed = message.trim();
    if (!trimmed || !connectionId || deletion.current || useGlobal.getState().conversationClearing?.[connectionId] || sendInFlight.current || !screenSession.current.active) return;
    const generation = screenSession.current.generation;
    sendInFlight.current = true;
    setIsSending(true);
    setSendError(null);
    typing.stop();
    try {
      const accepted = await messageSend(connectionId, trimmed);
      if (!mountedRef.current || !screenSession.current.active || generation !== screenSession.current.generation) return;
      if (!accepted) {
        setSendError(useGlobal.getState().outboxError || 'No se pudo guardar el mensaje. El texto sigue en el cuadro de texto; intenta nuevamente.');
        return;
      }
      setMessage((current) => current === submitted ? '' : current);
      scrollToLatest();
    } catch {
      if (mountedRef.current && screenSession.current.active && generation === screenSession.current.generation) {
        setSendError(useGlobal.getState().outboxError || 'No se pudo guardar el mensaje. El texto sigue en el cuadro de texto; intenta nuevamente.');
      }
    } finally {
      sendInFlight.current = false;
      if (mountedRef.current) setIsSending(false);
    }
  }, [connectionId, typing, message, messageSend, scrollToLatest]);

  const onRetry = useCallback(async (clientId) => {
    if (deletion.current || useGlobal.getState().conversationClearing?.[connectionId]) return;
    const generation = screenSession.current.generation;
    setSendError(null);
    try {
      if (await retryPendingMessage(clientId)) return;
    } catch { /* Keep the stored pending message visible if retry fails. */ }
    if (mountedRef.current && screenSession.current.active && generation === screenSession.current.generation) {
      setSendError(useGlobal.getState().outboxError || 'No se pudo reintentar. El mensaje sigue pendiente; intenta nuevamente.');
    }
  }, [connectionId, retryPendingMessage]);

  const onDiscard = useCallback(async (clientId) => {
    if (deletion.current || useGlobal.getState().conversationClearing?.[connectionId]) return;
    const generation = screenSession.current.generation;
    setSendError(null);
    try {
      if (await discardPendingMessage(clientId)) return;
    } catch { /* The pending message must remain when storage cannot be updated. */ }
    if (mountedRef.current && screenSession.current.active && generation === screenSession.current.generation) {
      setSendError(useGlobal.getState().outboxError || 'No se pudo quitar el pendiente. Intenta nuevamente.');
    }
  }, [connectionId, discardPendingMessage]);

  const openDelete = () => {
    const state = useGlobal.getState();
    if (deleteDisabled || !screenSession.current.active || !state.authenticated) return false;
    closeProfile();
    typing.stop();
    setDeleteTarget({ connectionId, username: state.user?.username, generation: screenSession.current.generation });
    setDeleteError(null);
    return true;
  };
  const openProfile = () => {
    const state = useGlobal.getState();
    if (!mountedRef.current || !screenSession.current.active || !state.authenticated || !connectionId || !friend?.username || deleteTarget) return;
    Keyboard.dismiss();
    typing.stop();
    const context = { connectionId, friendUsername: friend.username, username: state.user?.username, generation: screenSession.current.generation };
    profileContext.current = context;
    profileAction.current = null;
    setProfile({ context, visible: true });
  };
  const runProfileAction = (action, context) => {
    if (!currentProfile(context) || profileAction.current || (action === 'delete' ? deleteDisabled : callDisabled)) return false;
    if (Platform.OS === 'ios') {
      profileAction.current = { context, action };
      setProfile((previous) => previous?.context === context ? { ...previous, visible: false } : previous);
      return true;
    }
    closeProfile();
    return action === 'delete' ? openDelete() : onCall(action);
  };
  const dismissProfile = (context) => {
    if (profileContext.current !== context) return;
    const pending = profileAction.current;
    const valid = pending?.context === context && currentProfile(context);
    closeProfile();
    if (valid) {
      if (pending.action === 'delete') openDelete();
      else void onCall(pending.action);
    }
  };
  const deleteConversation = async () => {
    const state = useGlobal.getState();
    if (!deleteTarget || deletion.current || !screenSession.current.active || !state.authenticated ||
        state.user?.username !== deleteTarget.username || deleteTarget.generation !== screenSession.current.generation ||
        String(deleteTarget.connectionId) !== String(connectionId)) return false;
    const operation = deleteTarget;
    deletion.current = operation;
    typing.stop();
    setDeleteBusy(true); setDeleteError(null);
    const current = () => deletion.current === operation && mountedRef.current && screenSession.current.active &&
      screenSession.current.generation === operation.generation && useGlobal.getState().authenticated &&
      useGlobal.getState().user?.username === operation.username;
    try {
      const result = await clearConversation(operation.connectionId);
      if (!current()) return false;
      if (!result) throw new Error('No se pudo confirmar el borrado. Intenta nuevamente.');
      setDeleteTarget(null); setMessage(''); setSendError(null);
      setHistoryNotice('La conversación se borró para ambos.');
      return true;
    } catch (failure) {
      if (current()) setDeleteError(normalizeApiError(failure.response?.data,
        failure.message || 'No se pudo confirmar el borrado. Revisa la conexión e intenta nuevamente.'));
      return false;
    } finally {
      if (deletion.current === operation) {
        deletion.current = null;
        if (mountedRef.current) setDeleteBusy(false);
      }
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.customHeader}>
        <WebBackButton navigation={navigation} fallbackRoute="Home" style={styles.backButton} />
        <TouchableOpacity style={styles.avatarButton} onPress={openProfile} disabled={!authenticated || !connectionId || !friend?.username || !!deleteTarget} accessibilityRole="button" accessibilityLabel={`Ver perfil de ${friend?.name || friend?.username || 'contacto'}`} accessibilityHint="Ver foto, nombre y opciones del contacto" accessibilityState={{ disabled: !authenticated || !connectionId || !friend?.username || !!deleteTarget }}>
          <Miniatura url={friend?.miniatura} size={42} />
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={styles.headerText} numberOfLines={1}>{friend?.name || friend?.username || 'Conversación'}</Text>
          {!socketConnected && <Text style={styles.connectionText}>Sin conexión · los textos quedan pendientes</Text>}
        </View>
        <View style={styles.callActions}>
          <TouchableOpacity style={[styles.callButton, callDisabled && styles.callButtonDisabled]} disabled={callDisabled} onPress={() => onCall('audio')} accessibilityRole="button" accessibilityLabel="Llamar por audio" accessibilityState={{ disabled: callDisabled }}>
            <FontAwesomeIcon icon={faPhone} color="#155EA0" size={20} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.callButton, callDisabled && styles.callButtonDisabled]} disabled={callDisabled} onPress={() => onCall('video')} accessibilityRole="button" accessibilityLabel="Iniciar videollamada" accessibilityState={{ disabled: callDisabled }}>
            <FontAwesomeIcon icon={faVideo} color="#155EA0" size={21} />
          </TouchableOpacity>
        </View>
      </View>
      {callNotice && <Text style={styles.callNotice} accessibilityLiveRegion="polite">{callNotice}</Text>}
      {historyNotice && <Text style={styles.callNotice} accessibilityLiveRegion="polite">{historyNotice}</Text>}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}
      >
        <FlatList
          ref={flatListRef}
          style={styles.listViewport}
          data={visibleMessages}
          inverted
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.messageList}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item, index }) => <MessageBubble index={index} message={item} friend={friend} onRetry={clearing ? undefined : onRetry} onDiscard={clearing ? undefined : onDiscard} />}
        />
        {authenticated && !clearing && messagesTyping?.username === friend?.username &&
          String(messagesTyping?.connectionId) === String(connectionId) && (
            <View style={styles.typingIndicator}><MessageTypingIndicator friend={friend} draft={messagesTyping.draft} /></View>
        )}
        <View style={styles.inputContainer}>
          {sendError && <Text style={styles.sendError} accessibilityRole="alert" accessibilityLiveRegion="polite">{sendError}</Text>}
          {!media.preview && media.previewError && <Text style={styles.sendError} accessibilityRole="alert" accessibilityLiveRegion="polite">{media.previewError}</Text>}
          <MessageInput
            message={message}
            setMessage={onType}
            onSend={onSendMessage}
            onBlur={typing.stop}
            onImage={media.onImage}
            onSelectGif={media.onSelectGif}
            onCamera={media.onCamera}
            guardMediaSelection={media.guardSelection}
            onAudio={media.onAudio}
            onVideo={media.onVideo}
            onDocument={media.onDocument}
            onCancelRecording={media.onCancelRecording}
            isRecording={media.isRecording}
            isSending={isSending}
            disabled={media.isBusy || !connectionId || clearing}
            disabledPlaceholder={clearing ? 'Borrando conversación…' : undefined}
          />
        </View>
      </KeyboardAvoidingView>
      {media.preview && (
        <AttachmentPreview
          preview={media.preview}
          previewError={media.previewError}
          isUploading={media.isUploading}
          uploadProgress={media.uploadProgress}
          onConfirm={media.confirmPreview}
          onCancel={media.cancelPreview}
          onCancelUpload={media.cancelUpload}
        />
      )}
      {profile && <ContactProfile visible={profile.visible} friend={friend} callDisabled={callDisabled} deleteDisabled={deleteDisabled} callNotice={callNotice}
        onClose={() => { if (currentProfile(profile.context)) closeProfile(); }} onDismiss={() => dismissProfile(profile.context)} onAudioCall={() => runProfileAction('audio', profile.context)} onVideoCall={() => runProfileAction('video', profile.context)} onDelete={() => runProfileAction('delete', profile.context)} />}
      {deleteTarget && <DeleteConfirmation visible title="Borrar conversación"
        message="Se borrarán los mensajes y archivos de esta conversación para ambos participantes. Tus mensajes pendientes se cancelarán. Esta acción no se puede deshacer."
        busy={clearing} error={deleteError} onConfirm={deleteConversation} onCancel={() => { if (!deletion.current && !conversationClearing) { setDeleteTarget(null); setDeleteError(null); } }} />}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  webContent: { flex: 1, minHeight: 0, overflow: 'hidden' },
  container: { flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: '#f9f9f9' },
  customHeader: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#ddd',
    flexShrink: 0,
  },
  backButton: { marginRight: 12 },
  avatarButton: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerInfo: { flex: 1, minWidth: 0, marginLeft: 12 },
  headerText: { fontSize: 20, fontWeight: '600', color: '#333' },
  connectionText: { color: '#777', fontSize: 12, marginTop: 3 },
  callActions: { flexDirection: 'row', flexShrink: 0, marginLeft: 6, gap: 4 },
  callButton: { width: 44, minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EDF5FC' },
  callButtonDisabled: { opacity: 0.45 },
  callNotice: { color: '#365C78', fontSize: 12, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#EDF5FC', flexShrink: 0 },
  sendError: { color: '#8B2424', fontSize: 13, marginBottom: 6 },
  flex: { flex: 1, minHeight: 0 },
  listViewport: { flex: 1, minHeight: 0 },
  typingIndicator: { flexShrink: 0, paddingHorizontal: 12, paddingBottom: 4 },
  messageList: { paddingTop: 16, paddingHorizontal: 12 },
  inputContainer: {
    flexShrink: 0,
    borderTopColor: '#ddd', borderTopWidth: 1, backgroundColor: '#fff',
    paddingVertical: 10, paddingHorizontal: 12,
  },
});

export default MessagesScreen;

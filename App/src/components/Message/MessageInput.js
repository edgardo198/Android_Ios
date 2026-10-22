import React, { useCallback, useEffect, useRef, useState, memo } from 'react';
import { ActivityIndicator, Keyboard, Platform, View, TextInput, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import {
  faPaperPlane,
  faPaperclip,
  faImage,
  faMicrophone,
  faVideo,
  faFile,
  faFaceSmile,
} from '@fortawesome/free-solid-svg-icons';
import { useFocusEffect } from '@react-navigation/native';
import RecordingAnimation from '../Message/RecordingAnimation';
import ImageSourcePicker from './ImageSourcePicker';
import EmojiPicker from './EmojiPicker';
import { insertEmojiAtSelection } from './emojiData';
import useGlobal from '../../core/global';
import { useCalls } from '../../calls/CallsProvider';
import styles from '../../Styles/messageStyles';

const MessageInput = memo(
  ({
    message,
    setMessage,
    onSend,
    onBlur,
    onImage,
    onCamera,
    guardMediaSelection,
    onAudio,
    onVideo,
    onDocument,
    onSelectGif,
    onCancelRecording,
    isRecording,
    isSending = false,
    disabled = false,
    disabledPlaceholder = 'Subiendo archivo...',
  }) => {
    const [showMediaMenu, setShowMediaMenu] = useState(false);
    const [showImageSources, setShowImageSources] = useState(false);
    const pendingImageSource = useRef(null);
    const [showEmojis, setShowEmojis] = useState(false);
    const [selection, setSelection] = useState(undefined);
    const selectionRef = useRef(null);
    const inputRef = useRef(null);
    const emojiContext = useRef(null);
    const pendingEmojiFocus = useRef(null);
    const focused = useRef({ active: false, generation: 0 });
    const calls = useCalls();
    const callBlocked = !!calls.call && calls.call.status !== 'ended';
    const callIdentity = calls.call ? `${calls.call.id || 'preparing'}:${calls.call.status}` : null;
    const latest = useRef(null);
    latest.current = { message, setMessage, disabled, isRecording, callBlocked, onSelectGif };

    const invalidateEmoji = useCallback(() => {
      emojiContext.current = null;
      pendingEmojiFocus.current = null;
      setShowEmojis(false);
    }, []);
    useFocusEffect(useCallback(() => {
      focused.current = { active: true, generation: focused.current.generation + 1 };
      return () => {
        focused.current = { active: false, generation: focused.current.generation + 1 };
        invalidateEmoji();
      };
    }, [invalidateEmoji]));
    useEffect(() => useGlobal.subscribe((state, previous) => {
      const connectionId = state.messagesConnectionId;
      if (state.authenticated !== previous.authenticated || state.user?.username !== previous.user?.username ||
          connectionId !== previous.messagesConnectionId || state.messagesUsername !== previous.messagesUsername ||
          (state.conversationHistory?.[connectionId]?.revision || 0) !== (previous.conversationHistory?.[connectionId]?.revision || 0) ||
          state.conversationClearing?.[connectionId]) {
        invalidateEmoji(); selectionRef.current = null; setSelection(undefined);
      }
    }), [invalidateEmoji]);
    useEffect(() => { if (disabled || isRecording || callIdentity) invalidateEmoji(); }, [disabled, isRecording, callIdentity, invalidateEmoji]);
    useEffect(() => () => { pendingEmojiFocus.current = null; emojiContext.current = null; }, []);

    const captureContext = () => {
      const state = useGlobal.getState();
      return { auth: state.captureAuthSession(), connectionId: state.messagesConnectionId, username: state.messagesUsername,
        revision: state.conversationHistory?.[state.messagesConnectionId]?.revision || 0, generation: focused.current.generation };
    };
    const currentContext = (context) => {
      const state = useGlobal.getState();
      return !!context && focused.current.active && context.generation === focused.current.generation &&
        state.isAuthSessionCurrent(context.auth) && context.connectionId === state.messagesConnectionId && context.username === state.messagesUsername &&
        context.revision === (state.conversationHistory?.[context.connectionId]?.revision || 0) && !state.conversationClearing?.[context.connectionId] &&
        !latest.current.disabled && !latest.current.isRecording && !latest.current.callBlocked;
    };
    const restoreFocus = (context) => {
      const cursor = selectionRef.current && { ...selectionRef.current };
      const action = () => {
        if (emojiContext.current || !currentContext(context)) return;
        inputRef.current?.focus();
        if (cursor) {
          const length = String(latest.current.message || '').length;
          const next = { start: Math.min(length, cursor.start), end: Math.min(length, cursor.end) };
          selectionRef.current = next; setSelection(next);
          inputRef.current?.setNativeProps?.({ selection: next });
        }
      };
      if (Platform.OS === 'ios') pendingEmojiFocus.current = action;
      else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(action);
      else action();
    };
    const openEmojis = () => {
      const context = captureContext();
      if (!currentContext(context)) return;
      pendingImageSource.current = null;
      pendingEmojiFocus.current = null;
      setShowImageSources(false); setShowMediaMenu(false);
      emojiContext.current = context;
      if (Platform.OS !== 'web') Keyboard.dismiss();
      setShowEmojis(true);
    };
    const closeEmojis = (context = emojiContext.current) => {
      if (context !== emojiContext.current) return;
      emojiContext.current = null;
      setShowEmojis(false);
      restoreFocus(context);
    };
    const insertEmoji = (emoji, context) => {
      if (context !== emojiContext.current) return;
      if (!currentContext(context)) { invalidateEmoji(); return; }
      const result = insertEmojiAtSelection(latest.current.message, emoji, selectionRef.current);
      selectionRef.current = result.selection;
      setSelection(result.selection);
      // This is the same controlled callback used for typing and live draft updates.
      latest.current.setMessage?.(result.message);
      closeEmojis(context);
    };
    const chooseGif = () => {
      const context = captureContext();
      if (!currentContext(context) || !latest.current.onSelectGif) return;
      invalidateEmoji(); setShowMediaMenu(false);
      latest.current.onSelectGif();
    };

    useEffect(() => () => { pendingImageSource.current = null; }, []);

    useEffect(() => {
      if (disabled || isRecording) {
        pendingImageSource.current = null;
        setShowImageSources(false);
      }
    }, [disabled, isRecording]);

    const toggleMediaMenu = () => {
      if (!disabled && !isRecording) {
        setShowMediaMenu((prev) => !prev);
      }
    };

    const chooseImages = () => {
      if (disabled || isRecording) return;
      Keyboard.dismiss();
      setShowMediaMenu(false);
      setShowImageSources(true);
    };

    const selectImageSource = (action) => {
      setShowImageSources(false);
      if (disabled || isRecording) return;
      // iOS must finish dismissing this modal before presenting its system picker.
      if (Platform.OS === 'ios') {
        pendingImageSource.current = guardMediaSelection?.(action) || null;
        return;
      }
      // Do not defer this callback: web file pickers require the original user gesture.
      action?.();
    };

    const dismissImageSources = () => {
      const action = pendingImageSource.current;
      pendingImageSource.current = null;
      if (!disabled && !isRecording) action?.();
    };

    const pickerContext = emojiContext.current;

    return (
      <View style={inputStyles.container}>
        <View style={inputStyles.inputRow}>
          <TouchableOpacity
            onPress={toggleMediaMenu}
            style={inputStyles.clipButton}
            disabled={disabled || isRecording}
            accessibilityRole="button"
            accessibilityLabel="Adjuntar archivo"
            accessibilityState={{ disabled: !!(disabled || isRecording) }}
          >
            <FontAwesomeIcon icon={faPaperclip} size={24} color="#303040" />
          </TouchableOpacity>
          <TextInput
            ref={inputRef}
            placeholder={disabled ? disabledPlaceholder : 'Mensajes...'}
            placeholderTextColor="#909090"
            value={message}
            onChangeText={(text) => { setSelection(undefined); setMessage?.(text); }}
            selection={selection}
            onSelectionChange={(event) => {
              const next = event.nativeEvent?.selection;
              if (!next) return;
              selectionRef.current = { start: next.start, end: next.end };
              setSelection(selectionRef.current);
            }}
            onBlur={onBlur}
            style={[styles.textInput, inputStyles.textInput]}
            editable={!disabled && !isRecording}
            accessibilityLabel="Mensaje"
          />
          <TouchableOpacity
            onPress={onSend}
            style={inputStyles.sendButtonContainer}
            disabled={disabled || isRecording || isSending || !message.trim()}
            accessibilityRole="button"
            accessibilityLabel={isSending ? 'Guardando mensaje' : 'Enviar mensaje'}
            accessibilityState={{ disabled: disabled || isRecording || isSending || !message.trim(), busy: isSending }}
          >
            {isSending ? <ActivityIndicator size="small" color="#303040" /> : <FontAwesomeIcon icon={faPaperPlane} size={22} color="#303040" />}
          </TouchableOpacity>
        </View>

        {(showMediaMenu || isRecording) && (
          <View style={inputStyles.mediaMenuContainer}>
            <TouchableOpacity onPress={openEmojis} style={inputStyles.mediaMenuItem} disabled={disabled || isRecording || callBlocked}
              accessibilityRole="button" accessibilityLabel="Elegir emoji" accessibilityState={{ disabled: disabled || isRecording || callBlocked }}>
              <FontAwesomeIcon icon={faFaceSmile} size={20} color="#155EA0" />
              <Text style={inputStyles.mediaMenuText}>Emojis</Text>
            </TouchableOpacity>
            {!!onSelectGif && <TouchableOpacity onPress={chooseGif} style={inputStyles.mediaMenuItem} disabled={disabled || isRecording || callBlocked}
              accessibilityRole="button" accessibilityLabel="Enviar GIF" accessibilityState={{ disabled: disabled || isRecording || callBlocked }}>
              <Text style={inputStyles.gifIcon}>GIF</Text>
              <Text style={inputStyles.mediaMenuText}>GIF</Text>
            </TouchableOpacity>}
            <TouchableOpacity onPress={chooseImages} style={inputStyles.mediaMenuItem} disabled={disabled || isRecording}
              accessibilityRole="button" accessibilityLabel="Imágenes: galería o cámara">
              <FontAwesomeIcon icon={faImage} size={20} color="#303040" />
              <Text style={inputStyles.mediaMenuText}>Imágenes</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onVideo} style={inputStyles.mediaMenuItem} disabled={disabled || isRecording}>
              <FontAwesomeIcon icon={faVideo} size={20} color="#303040" />
              <Text style={inputStyles.mediaMenuText}>Video</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onDocument}
              style={inputStyles.mediaMenuItem}
              disabled={disabled || isRecording}
            >
              <FontAwesomeIcon icon={faFile} size={20} color="#303040" />
              <Text style={inputStyles.mediaMenuText}>Documento</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onAudio} style={inputStyles.mediaMenuItem} disabled={disabled}>
              <FontAwesomeIcon icon={faMicrophone} size={20} color="#303040" />
              <Text style={inputStyles.mediaMenuText}>
                {isRecording ? 'Detener y revisar' : 'Audio'}
              </Text>
            </TouchableOpacity>
            {isRecording && <RecordingAnimation />}
            {isRecording && (
              <TouchableOpacity onPress={onCancelRecording} style={inputStyles.mediaMenuItem} disabled={disabled}>
                <Text style={inputStyles.mediaMenuText}>Cancelar</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        <ImageSourcePicker
          visible={showImageSources && !disabled && !isRecording}
          disabled={disabled || isRecording}
          onGallery={() => selectImageSource(onImage)}
          onCamera={onCamera ? () => selectImageSource(onCamera) : undefined}
          onClose={() => { pendingImageSource.current = null; setShowImageSources(false); }}
          onDismiss={dismissImageSources}
        />
        <EmojiPicker visible={showEmojis && !disabled && !isRecording && !callBlocked} disabled={disabled || isRecording || callBlocked}
          onSelect={(emoji) => insertEmoji(emoji, pickerContext)} onClose={() => closeEmojis(pickerContext)} onDismiss={() => {
            const action = pendingEmojiFocus.current; pendingEmojiFocus.current = null; action?.();
          }} />
      </View>
    );
  }
);

const inputStyles = StyleSheet.create({
  container: {
    backgroundColor: '#fff',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  clipButton: {
    padding: 6,
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#ccc',
  },
  sendButtonContainer: {
    padding: 6,
  },
  mediaMenuContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: '#f9f9f9',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#eee',
    flexWrap: 'wrap',
  },
  mediaMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    minHeight: 44,
  },
  gifIcon: { color: '#155EA0', fontSize: 12, fontWeight: '800', borderWidth: 1, borderColor: '#155EA0', borderRadius: 4, paddingHorizontal: 3, paddingVertical: 1 },
  mediaMenuText: {
    marginLeft: 6,
    fontSize: 14,
    color: '#303040',
  },
});

export default MessageInput;

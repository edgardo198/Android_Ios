import React, { memo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import MessageContent from './MessageContent';
import MessageMetadata from './MessageMetadata';
import styles from '../../Styles/messageStyles';

const MessageBubbleMe = memo(({ message, onImagePress, onRetry, onDiscard }) => {
  const [working, setWorking] = useState(false);
  const actionInFlight = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const status = message.deliveryStatus;
  const pending = status === 'pending' || status === 'failed';
  const label = status === 'sending' ? 'Enviando…' : status === 'failed' ? 'Sin confirmación' : 'Pendiente';
  const action = async (callback) => {
    if (actionInFlight.current || !callback) return;
    actionInFlight.current = true;
    setWorking(true);
    try { await callback(message.clientId); } finally {
      actionInFlight.current = false;
      if (mountedRef.current) setWorking(false);
    }
  };

  return (
    <View style={styles.bubbleContainerMe}>
      <View style={[styles.bubbleMe, message.audio && styles.audioBubble]}>
        <MessageContent message={message} onImagePress={onImagePress} />
        <MessageMetadata message={message} sentByMe />
        {status && (
          <View style={styles.deliveryContainer}>
            <View style={styles.deliveryStatusRow}>
              {status === 'sending' && <ActivityIndicator size="small" color="#365C78" />}
              <Text style={[styles.deliveryText, status === 'failed' && styles.deliveryError]} accessibilityLiveRegion="polite">
                {label}
              </Text>
            </View>
            {status === 'failed' && message.deliveryError && <Text style={styles.deliveryError}>{message.deliveryError}</Text>}
            {status === 'failed' && <Text style={styles.deliveryHelp}>Puedes reintentar sin duplicar el mensaje.</Text>}
            {pending && (
              <View style={styles.deliveryActions}>
                <TouchableOpacity
                  onPress={() => action(onRetry)}
                  style={styles.deliveryButton}
                  disabled={working || !onRetry}
                  accessibilityRole="button"
                  accessibilityLabel="Reintentar envío del mensaje"
                  accessibilityState={{ disabled: working || !onRetry, busy: working }}
                >
                  <Text style={styles.deliveryButtonText}>Reintentar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => action(onDiscard)}
                  style={styles.deliveryButton}
                  disabled={working || !onDiscard}
                  accessibilityRole="button"
                  accessibilityLabel="Quitar mensaje de la lista de pendientes"
                  accessibilityState={{ disabled: working || !onDiscard, busy: working }}
                >
                  <Text style={styles.deliveryDiscardText}>Quitar pendiente</Text>
                </TouchableOpacity>
              </View>
            )}
            {pending && <Text style={styles.deliveryHelp}>Quitar el pendiente no borra mensajes que ya llegaron.</Text>}
          </View>
        )}
      </View>
    </View>
  );
});

export default MessageBubbleMe;

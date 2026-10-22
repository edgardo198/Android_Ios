import React, { memo } from 'react';
import { Text, View } from 'react-native';
import styles from '../../Styles/messageStyles';

export function messageTime(created) {
  if (typeof created !== 'string' || !created.trim()) return null;
  const date = new Date(created);
  if (!Number.isFinite(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function messageReceipt(message, sentByMe) {
  if (!sentByMe || message?.deliveryStatus || !/^[1-9]\d*$/.test(String(message?.id))) return null;
  return message.isNew === false ? 'Leído' : 'Enviado';
}

const MessageMetadata = memo(({ message, sentByMe = false }) => {
  const time = messageTime(message?.created);
  const receipt = messageReceipt(message, sentByMe);
  if (!time && !receipt) return null;
  return (
    <View style={styles.metadataRow}>
      {time && <Text style={styles.metadataText} accessibilityLabel={`Hora del mensaje: ${time}`}>{time}</Text>}
      {receipt && <Text
        style={[styles.metadataText, receipt === 'Leído' && styles.readReceipt]}
        accessibilityLabel={`Estado del mensaje: ${receipt}`}
        accessibilityLiveRegion="polite"
      >{receipt}</Text>}
    </View>
  );
});

export default MessageMetadata;

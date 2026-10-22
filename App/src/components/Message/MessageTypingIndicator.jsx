import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MessageBubbleFriend from './MessageBubbleFriend';
import { boundedTypingDraft } from '../../core/typing';

export default function MessageTypingIndicator({ friend, draft }) {
  const text = boundedTypingDraft(draft);
  return (
    <View>
      <View accessible accessibilityLabel={`${friend?.name || friend?.username || 'Contacto'} está escribiendo`} accessibilityLiveRegion="polite">
        <MessageBubbleFriend message={{}} friend={friend} typing />
      </View>
      {!!text?.trim() && <View style={styles.preview}>
        <Text style={styles.label}>Borrador sin enviar</Text>
        <Text style={styles.draft} numberOfLines={3}>{text}</Text>
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { marginLeft: 54, marginRight: 12, marginBottom: 6, maxWidth: 320, borderRadius: 12, padding: 10, backgroundColor: '#EDF5FC' },
  label: { color: '#365C78', fontSize: 11, fontWeight: '600', marginBottom: 3 },
  draft: { color: '#163B5D', fontSize: 14, lineHeight: 19, flexShrink: 1 },
});

import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faPhone, faTimes, faTrash, faVideo } from '@fortawesome/free-solid-svg-icons';
import Miniatura from '../../common/Miniatura';

export default function ContactProfile({ visible, friend, callDisabled, deleteDisabled, callNotice,
  onClose, onDismiss, onAudioCall, onVideoCall, onDelete }) {
  const name = friend?.name || friend?.username || 'Contacto';
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={onDismiss}>
      <SafeAreaView style={styles.backdrop}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card} accessibilityViewIsModal>
            <View style={styles.heading}>
              <Text style={styles.title} accessibilityRole="header">Perfil del contacto</Text>
              <TouchableOpacity style={styles.closeButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Cerrar perfil del contacto">
                <FontAwesomeIcon icon={faTimes} size={18} color="#365C78" />
              </TouchableOpacity>
            </View>
            <View style={styles.identity}>
              <View style={styles.portrait} accessible accessibilityRole="image" accessibilityLabel={`Foto de ${name}`}>
                <Miniatura url={friend?.miniatura} size={104} />
              </View>
              <Text style={styles.name} accessibilityRole="header">{name}</Text>
              {!!friend?.username && <Text style={styles.username}>@{friend.username}</Text>}
            </View>
            <View style={styles.callActions}>
              <TouchableOpacity style={[styles.callButton, callDisabled && styles.disabled]} disabled={callDisabled} onPress={onAudioCall} accessibilityRole="button" accessibilityLabel="Llamar por audio desde el perfil" accessibilityState={{ disabled: callDisabled }}>
                <View style={styles.callIcon}><FontAwesomeIcon icon={faPhone} color="#155EA0" size={23} /></View>
                <Text style={styles.callText}>Audio</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.callButton, callDisabled && styles.disabled]} disabled={callDisabled} onPress={onVideoCall} accessibilityRole="button" accessibilityLabel="Iniciar videollamada desde el perfil" accessibilityState={{ disabled: callDisabled }}>
                <View style={styles.callIcon}><FontAwesomeIcon icon={faVideo} color="#155EA0" size={23} /></View>
                <Text style={styles.callText}>Videollamada</Text>
              </TouchableOpacity>
            </View>
            {callNotice && <Text style={styles.notice} accessibilityLiveRegion="polite">{callNotice}</Text>}
            <TouchableOpacity style={[styles.deleteButton, deleteDisabled && styles.disabled]} disabled={deleteDisabled} onPress={onDelete} accessibilityRole="button" accessibilityLabel="Borrar conversación" accessibilityState={{ disabled: deleteDisabled }}>
              <FontAwesomeIcon icon={faTrash} color="#8B2424" size={17} />
              <Text style={styles.deleteText}>Borrar conversación</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(13, 35, 53, 0.5)' },
  scroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 440, borderRadius: 24, padding: 20, backgroundColor: '#FFFFFF', gap: 20 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { flex: 1, minWidth: 0, color: '#365C78', fontSize: 15, fontWeight: '600' },
  closeButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#F2F6FA', justifyContent: 'center', alignItems: 'center' },
  identity: { alignItems: 'center', gap: 10 },
  portrait: { padding: 6, backgroundColor: '#EDF5FC', borderRadius: 60 },
  name: { color: '#163B5D', fontSize: 24, fontWeight: '700', textAlign: 'center', alignSelf: 'stretch' },
  username: { color: '#56738B', fontSize: 15, textAlign: 'center', alignSelf: 'stretch' },
  callActions: { flexDirection: 'row', gap: 12 },
  callButton: { flex: 1, minWidth: 0, minHeight: 94, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#F1F7FC', borderRadius: 16, paddingVertical: 12, paddingHorizontal: 6 },
  callIcon: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  callText: { color: '#155EA0', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  notice: { color: '#365C78', fontSize: 13, lineHeight: 20, textAlign: 'center' },
  deleteButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 10, borderTopWidth: 1, borderTopColor: '#E5EDF4', paddingTop: 16 },
  deleteText: { color: '#8B2424', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  disabled: { opacity: 0.5 },
});

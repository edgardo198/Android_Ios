import { StyleSheet, Platform } from 'react-native';

export default StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5', // Fondo off-white para toda la app
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF', // Fondo blanco para el header
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
    // Sombra sutil para dar profundidad (solo iOS y Android)
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  headerText: {
    color: '#333333',
    marginLeft: 12,
    fontSize: 20,
    fontWeight: '600',
  },
  messageInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF', // Fondo blanco para la entrada de mensajes
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
  },
  mediaButtonsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  mediaButton: {
    marginHorizontal: 6,
  },
  textInput: {
    flex: 1,
    height: 48,
    borderWidth: 1,
    borderRadius: 24,
    borderColor: '#CCCCCC',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#333333',
  },
  sendButton: {
    marginLeft: 10,
  },
  bubbleContainerMe: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 8,
    marginVertical: 4,
  },
  bubbleMe: {
    backgroundColor: '#B3DAFF', 
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 14,
    maxWidth: '80%',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 1,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  bubbleFriend: {
    backgroundColor: '#FFFFFF', // Fondo blanco para mensajes recibidos
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 14,
    maxWidth: '80%',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    marginLeft: 8,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 1,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  audioBubble: {
    width: 300,
    flexShrink: 1,
  },
  bubbleText: {
    fontSize: 16,
    lineHeight: 20,
    color: '#333333',
  },
  metadataRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  metadataText: {
    color: '#365C78',
    fontSize: 11,
    flexShrink: 1,
  },
  readReceipt: {
    color: '#155EA0',
    fontWeight: '600',
  },
  deliveryContainer: {
    marginTop: 8,
  },
  deliveryStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  deliveryText: {
    color: '#365C78',
    fontSize: 12,
    flexShrink: 1,
  },
  deliveryError: {
    color: '#8B2424',
    fontSize: 12,
    marginTop: 3,
  },
  deliveryHelp: {
    color: '#365C78',
    fontSize: 12,
    marginTop: 4,
  },
  deliveryActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  deliveryButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  deliveryButtonText: {
    color: '#214C72',
    fontSize: 13,
    fontWeight: '600',
  },
  deliveryDiscardText: {
    color: '#763232',
    fontSize: 13,
    fontWeight: '600',
  },
  fullScreenModal: {
    flex: 1,
    backgroundColor: '#FFFFFF', // Fondo blanco para el modal en pantalla completa
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullScreenImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'contain',
  },
  closeButton: {
    position: 'absolute',
    top: 40,
    right: 20,
    padding: 10,
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderRadius: 20,
    zIndex: 10,
  },
  closeButtonText: {
    fontSize: 16,
    color: '#333333',
  },
  emojiButton: {
    marginHorizontal: 8,
  },
  
  emojiPickerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  
  closeEmojiButton: {
    marginTop: 10,
    padding: 10,
    backgroundColor: '#fff',
    borderRadius: 5,
  },
  
  closeEmojiText: {
    color: '#303040',
    fontWeight: 'bold',
  },
});


import React, { memo } from 'react';
import { View } from 'react-native';
import Miniatura from '../../common/Miniatura';
import MessageContent from './MessageContent';
import MessageMetadata from './MessageMetadata';
import styles from '../../Styles/messageStyles';
import MessageTypingAnimation from './MessageTypingAnimation';

const MessageBubbleFriend = memo(({ message, friend, typing = false, onImagePress }) => (
  <View style={{ flexDirection: 'row', padding: 4, justifyContent: 'flex-start' }}>
    <Miniatura url={friend?.miniatura} size={42} />
    <View style={[styles.bubbleFriend, !typing && message.audio && styles.audioBubble]}>
      {typing ? (
        <View style={{ flexDirection: 'row' }}>
          <MessageTypingAnimation delay={0} />
          <MessageTypingAnimation delay={100} />
          <MessageTypingAnimation delay={200} />
        </View>
      ) : (
        <>
          <MessageContent message={message} onImagePress={onImagePress} />
          <MessageMetadata message={message} />
        </>
      )}
    </View>
  </View>
));

export default MessageBubbleFriend;

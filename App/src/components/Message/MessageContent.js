import React, { memo } from 'react';
import { Text } from 'react-native';
import MessageImage from './MessageImage';
import AudioPlayer from './AudioPlayer';
import MessageDocument from './MessageDocument';
import MessageVideo from './MessageVideo'; 
import styles from '../../Styles/messageStyles';

const MessageContent = memo(({ message, onImagePress }) => {
  if (message.image) {
    return <MessageImage message={message} onImagePress={onImagePress} />;
  } else if (message.audio) {
    return (
      <AudioPlayer
        audioUri={message.audio}
        isMe={message.is_me}
      />
    );
  } else if (message.document) {
    return <MessageDocument message={message} />; 
  } else if (message.video) {
    return <MessageVideo message={message} />; 
  } else {
    return <Text style={styles.bubbleText}>{message.text}</Text>;
  }
});

export default MessageContent;

import React, { memo } from 'react';
import MessageBubbleMe from './MessageBubbleMe';
import MessageBubbleFriend from './MessageBubbleFriend';

const MessageBubble = memo(({ message, friend, onImagePress, onRetry, onDiscard }) => (
      message.is_me ? (
        <MessageBubbleMe message={message} onImagePress={onImagePress} onRetry={onRetry} onDiscard={onDiscard} />
      ) : (
        <MessageBubbleFriend message={message} friend={friend} onImagePress={onImagePress} />
      )
));

export default MessageBubble;

import React, { memo } from 'react';
import { View, Text } from 'react-native';
import Miniatura from '../../common/Miniatura';
import styles from '../../Styles/messageStyles';

const MessageHeader = memo(({ friend }) => (
  <View style={styles.header}>
    <Miniatura url={friend?.miniatura} size={35} />
    <Text style={styles.headerText}>{friend?.name}</Text>
  </View>
));

export default MessageHeader;

import React, { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Cell from '../../common/Cell';
import Miniatura from '../../common/Miniatura';
import useGlobal from '../../core/global';
import { formatTime } from '../../core/utils';
import { messagePreview } from '../Message/mediaMetadata';

const FriendRow = memo(({ item }) => {
  const navigation = useNavigation();
  const markFriendAsRead = useGlobal((state) => state.markFriendAsRead);
  const friend = item?.friend;
  const unreadCount = Number(item?.unreadCount) || 0;
  const handlePress = useCallback(() => {
    if (!friend?.username) return;
    markFriendAsRead(friend.username);
    navigation.navigate('Messages', item);
  }, [friend?.username, item, markFriendAsRead, navigation]);
  return (
    <TouchableOpacity onPress={handlePress} accessibilityRole="button">
      <Cell>
        <View style={styles.avatarContainer}>
          <Miniatura url={friend?.miniatura} size={76} />
          {unreadCount > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
            </View>
          )}
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.name} numberOfLines={1}>{friend?.name || friend?.username || 'Usuario'}</Text>
          <Text style={styles.preview} numberOfLines={2}>{messagePreview(item?.message, item?.preview)}</Text>
          <Text style={styles.time}>{formatTime(item?.updated)}</Text>
        </View>
      </Cell>
    </TouchableOpacity>
  );
});
const styles = StyleSheet.create({
  avatarContainer: { width: 76, height: 76 },
  textContainer: { flex: 1, marginLeft: 12 },
  name: { fontSize: 16, fontWeight: 'bold', color: '#202020' },
  preview: { fontSize: 14, color: '#404040', marginTop: 3 },
  time: { fontSize: 12, color: '#909090', marginTop: 3 },
  unreadBadge: {
    position: 'absolute', bottom: 0, right: 0, minWidth: 20, height: 20, borderRadius: 10,
    backgroundColor: '#dc2626', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4,
  },
  unreadText: { color: '#fff', fontWeight: 'bold', fontSize: 12 },
});
export default FriendRow;

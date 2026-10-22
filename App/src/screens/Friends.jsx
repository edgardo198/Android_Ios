import React from 'react';
import { ActivityIndicator, FlatList } from 'react-native';
import { faInbox } from '@fortawesome/free-solid-svg-icons';
import FriendRow from '../components/Friends/FriendRow';
import Empty from '../common/Empty';
import useGlobal from '../core/global';

export default function FriendsScreen() {
  const friendList = useGlobal((state) => state.friendList);
  if (friendList === null) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!friendList?.length) return <Empty icon={faInbox} message="Sin mensajes" />;
  return (
    <FlatList
      data={friendList}
      renderItem={({ item }) => <FriendRow item={item} />}
      keyExtractor={(item) => String(item.id ?? item.friend?.username)}
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={5}
    />
  );
}




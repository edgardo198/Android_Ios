import React, { useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faCircleCheck, faMagnifyingGlass, faTimesCircle } from '@fortawesome/free-solid-svg-icons';
import Cell from '../common/Cell';
import Empty from '../common/Empty';
import Miniatura from '../common/Miniatura';
import WebBackButton from '../common/WebBackButton';
import useGlobal from '../core/global';

function SearchButton({ user }) {
  const requestConnect = useGlobal((state) => state.requestConnect);
  const requestAccept = useGlobal((state) => state.requestAccept);
  const socketConnected = useGlobal((state) => state.socketConnected);

  const statusMap = {
    connected: { icon: faCircleCheck, color: '#20d080', onPress: null, text: '' },
    'no-connection': {
      text: 'Conectar',
      color: '#202020',
      onPress: () => requestConnect(user.username),
    },
    'pending-them': { text: 'Pendiente', color: '#808080', onPress: null },
    'pending-me': {
      text: 'Aceptar',
      color: '#202020',
      onPress: () => requestAccept(user.username),
    },
  };

  const cfg = statusMap[user.status] || {};

  if (user.status === 'connected') {
    return <FontAwesomeIcon icon={cfg.icon} size={32} color={cfg.color} />;
  }

  return (
    <TouchableOpacity
      style={[
        styles.connectButton,
        { backgroundColor: cfg.onPress ? '#202020' : '#F0F0F0' },
      ]}
      onPress={cfg.onPress}
      disabled={!cfg.onPress || !socketConnected}
    >
      <Text
        style={[
          styles.connectText,
          { color: cfg.onPress ? '#FFFFFF' : '#A0A0A0' },
        ]}
      >
        {cfg.text}
      </Text>
    </TouchableOpacity>
  );
}

function SearchRow({ user }) {
  return (
    <Cell style={styles.rowContainer}>
      <Miniatura url={user.miniatura} size={60} />
      <View style={styles.infoContainer}>
        <Text style={styles.name}>{user.name}</Text>
        <Text style={styles.username}>@{user.username}</Text>
      </View>
      <SearchButton user={user} />
    </Cell>
  );
}

function SearchScreen({ navigation }) {
  const [query, setQuery] = useState('');
  const searchList = useGlobal((state) => state.searchList) || [];
  const searchUsers = useGlobal((state) => state.searchUsers);
  const socketConnected = useGlobal((state) => state.socketConnected);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      searchUsers('');
      return;
    }
    const timeout = setTimeout(() => searchUsers(normalized), 300);
    return () => clearTimeout(timeout);
  }, [query, searchUsers, socketConnected]);

  const clearQuery = () => setQuery('');

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.searchBarContainer}>
        <WebBackButton navigation={navigation} fallbackRoute="Home" style={styles.backButton} />
        <View style={styles.searchBox}>
          <FontAwesomeIcon
            icon={faMagnifyingGlass}
            size={24}
            color="#888"
            style={styles.searchIcon}
          />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Buscar amigos..."
            placeholderTextColor="#888"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={clearQuery} style={styles.clearIcon}>
              <FontAwesomeIcon icon={faTimesCircle} size={18} color="#888" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {searchList.length === 0 ? (
        <Empty
          icon={faMagnifyingGlass}
          message={query ? `No se encontro: "${query}"` : 'Buscar Amigos'}
        />
      ) : (
        <FlatList
          data={searchList}
          renderItem={({ item }) => <SearchRow user={item} />}
          keyExtractor={(item) => item.username}
          contentContainerStyle={styles.listContent}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  searchBarContainer: {
    padding: 16,
    backgroundColor: '#FFF',
    marginTop: 30,
    marginBottom: 10,
  },
  backButton: {
    marginBottom: 14,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0F0F0',
    borderRadius: 30,
    paddingHorizontal: 12,
    height: 44,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 6,
    elevation: 3,
  },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 16, color: '#333' },
  clearIcon: { marginLeft: 8 },
  listContent: { paddingHorizontal: 16, paddingVertical: 8 },
  rowContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: 10,
  },
  infoContainer: { flex: 1, marginHorizontal: 12 },
  name: { fontSize: 16, fontWeight: '600', color: '#202020' },
  username: { fontSize: 14, color: '#666' },
  connectButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginVertical: 4,
  },
  connectText: { fontSize: 14, fontWeight: '600' },
});

export default SearchScreen;

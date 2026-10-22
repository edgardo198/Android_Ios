import React, { useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { Platform, View, Text } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';
import { faInbox, faUser, faUserFriends, faSearch } from '@fortawesome/free-solid-svg-icons';
import { TouchableOpacity } from 'react-native-gesture-handler';
import useGlobal from '../core/global';
import Miniatura from '../common/Miniatura';
import RequestScreen from './Requests';
import FriendsScreen from './Friends';
import ProfileScreen from './Profile';
import { useAudioPlayer } from 'expo-audio';
import { useIsFocused } from '@react-navigation/native';
import debounce from 'lodash/debounce';

const Tab = createBottomTabNavigator();

const icons = {
  Solicitudes: faInbox,
  Amigos: faUserFriends,
  Perfil: faUser,
};

const HomeScreen = ({ navigation }) => {
  const user = useGlobal((state) => state.user);
  const friendList = useGlobal((state) => state.friendList) || [];
  const requestList = useGlobal((state) => state.requestList) || [];
  const lastReceivedMessageId = useGlobal((state) => state.lastReceivedMessageId);
  const isFocused = useIsFocused();

  // Cálculo de mensajes nuevos (solo para mensajes recibidos)
  const totalUnread = useMemo(() => {
    return friendList.reduce((acc, friendItem) => {
      return acc + (friendItem.unreadCount || 0);
    }, 0);
  }, [friendList]);

  // Estado para el contador mostrado, actualizado con debounce
  const newRequestsCount = requestList.length;
  const previousMessageIdRef = useRef(lastReceivedMessageId);

  // Cargar y cachear el sonido para notificación
  const notificationSound = useAudioPlayer(require('../assets/sonidos/messenger-tono-mensaje-.mp3'));
  const playNotificationSound = useCallback(async () => {
    if (Platform.OS !== 'web') {
      try {
        await notificationSound.seekTo(0);
        notificationSound.play();
      } catch (error) {
        console.log('Error al reproducir sonido:', error);
      }
    }
  }, [notificationSound]);

  // Debounce para evitar múltiples reproducciones en ráfaga
  const debouncedPlaySound = useMemo(
    () =>
    debounce(() => {
      playNotificationSound();
    }, 500),
    [playNotificationSound]
  );

  // Reproduce el sonido si aumenta totalUnread y la pantalla está activa
  useEffect(() => {
    if (isFocused && lastReceivedMessageId && lastReceivedMessageId !== previousMessageIdRef.current) {
      debouncedPlaySound();
    }
    previousMessageIdRef.current = lastReceivedMessageId;
    return () => debouncedPlaySound.cancel();
  }, [lastReceivedMessageId, isFocused, debouncedPlaySound]);

  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  const onSearch = () => {
    navigation.navigate('Search');
  };

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerLeft: () => (
          <View style={{ marginLeft: 16 }}>
            <Miniatura url={user?.miniatura} size={32} />
          </View>
        ),
        headerRight: () => (
          <TouchableOpacity onPress={onSearch}>
            <FontAwesomeIcon
              style={{ marginRight: 16 }}
              icon={faSearch}
              size={22}
              color="#00a2ed"
            />
          </TouchableOpacity>
        ),
        tabBarIcon: ({ color, size }) => {
          const icon = icons[route.name];
          return (
            <View style={{ position: 'relative' }}>
              <FontAwesomeIcon icon={icon} size={size} color={color} />
              {route.name === 'Amigos' && totalUnread > 0 && (
                <View
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -10,
                    minWidth: 18,
                    height: 18,
                    borderRadius: 9,
                    backgroundColor: 'red',
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingHorizontal: 4,
                  }}
                >
                  <Text style={{ color: 'white', fontSize: 10, fontWeight: 'bold' }}>
                    {totalUnread}
                  </Text>
                </View>
              )}
              {route.name === 'Solicitudes' && newRequestsCount > 0 && (
                <View
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -10,
                    minWidth: 18,
                    height: 18,
                    borderRadius: 9,
                    backgroundColor: 'red',
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingHorizontal: 4,
                  }}
                >
                  <Text style={{ color: 'white', fontSize: 10, fontWeight: 'bold' }}>
                    {newRequestsCount}
                  </Text>
                </View>
              )}
            </View>
          );
        },
        tabBarActiveTintColor: '#00a2ed',
        tabBarInactiveTintColor: 'gray',
        tabBarShowLabel: false,
      })}
    >
      <Tab.Screen name="Solicitudes" component={RequestScreen} />
      <Tab.Screen name="Amigos" component={FriendsScreen} />
      <Tab.Screen name="Perfil" component={ProfileScreen} />
    </Tab.Navigator>
  );
};

export default HomeScreen;














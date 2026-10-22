import { Alert, Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';

const notificationsSupported = Platform.OS !== 'web';

export async function registerForPushNotificationsAsync() {
  if (!notificationsSupported) {
    return null;
  }

  // Expo Go cannot receive remote push notifications. Do not request permissions
  // for a feature unavailable in the current runtime.
  if (isRunningInExpoGo() || Constants.executionEnvironment === 'storeClient') return null;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) return null;

  try {
    // Importing this module starts push listeners, which throw in Android Expo Go.
    // Load it only after confirming that this runtime supports remote notifications.
    const Notifications = require('expo-notifications');
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Mensajes',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    if (status !== 'granted') {
      Alert.alert('Permisos necesarios', 'Es necesario dar permisos para notificaciones.');
      return null;
    }

    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return token.data;
  } catch (error) {
    console.warn('No se pudo registrar el push token:', error?.message || error);
    return null;
  }
}

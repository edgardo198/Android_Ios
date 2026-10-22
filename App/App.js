import React, { useEffect, useRef } from 'react';
import { AppState, Linking, Platform, StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import SplashScreen from './src/screens/Splash';
import SignInScreen from './src/screens/Signin';
import SignUpScreen from './src/screens/SignUp';
import ForgotPasswordScreen from './src/screens/ForgotPassword';
import ResetPasswordScreen from './src/screens/ResetPassword';
import HomeScreen from './src/screens/Home';
import SearchScreen from './src/screens/Search';
import MessagesScreen from './src/screens/Messages';
import CallDiagnosticsScreen from './src/calls/screens/CallDiagnosticsScreen';
import CallHistoryScreen from './src/calls/screens/CallHistoryScreen';
import { CallsProvider } from './src/calls/CallsProvider';
import CallOverlay from './src/calls/CallOverlay';
import './src/core/fontawesome';
import useGlobal from './src/core/global';
import BackgroundNotices, { flushPendingNoticeOpen } from './src/notifications/BackgroundNotices';
import { clearPasswordResetUrl, createPasswordResetLinkCoordinator, rememberPasswordResetLink, takePasswordResetLink } from './src/common/passwordRecovery';

// Define custom theme
const DefaultThemeBlue = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: '#00a2ed',
    background: '#f0f8ff',
    card: '#ffffff',
    text: '#333333',
    border: '#c0c0c0',
    notification: '#00a2ed',
  },
};

const Stack = createNativeStackNavigator();

export default function App() {
  const initialized = useGlobal(state => state.initialized);
  const authenticated = useGlobal(state => state.authenticated);
  const init = useGlobal(state => state.init);
  const socketConnect = useGlobal(state => state.socketConnect);
  const socketClose = useGlobal(state => state.socketClose);
  const navigationRef = useRef(null);
  const resetLinks = useRef(null);
  const linkEffectActive = useRef(false);
  const linkGeneration = useRef(0);
  const initialLinkRead = useRef(false);
  const lastLinkRequest = useRef(null);
  if (!resetLinks.current) {
    resetLinks.current = createPasswordResetLinkCoordinator({
      isReady: () => useGlobal.getState().initialized && navigationRef.current?.isReady(),
      webOrigin: Platform.OS === 'web' ? globalThis.window?.location?.origin : undefined,
      onCleanUrl: () => { if (Platform.OS === 'web') clearPasswordResetUrl(globalThis.window); },
      onOpen: (link) => {
        const requestId = rememberPasswordResetLink(link);
        lastLinkRequest.current = requestId;
        navigationRef.current.navigate('ResetPassword', { requestId });
      },
    });
  }

  useEffect(() => {
    linkEffectActive.current = true;
    const generation = ++linkGeneration.current;
    let receivedLiveLink = false;
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (resetLinks.current.receive(url)) receivedLiveLink = true;
    });
    if (Platform.OS === 'web') {
      if (!initialLinkRead.current) {
        initialLinkRead.current = true;
        resetLinks.current.receive(globalThis.window?.location?.href);
      }
    } else if (!initialLinkRead.current) {
      Linking.getInitialURL().then((url) => {
        if (!linkEffectActive.current || generation !== linkGeneration.current || receivedLiveLink) return;
        initialLinkRead.current = true;
        resetLinks.current.receive(url);
      }).catch(() => {});
    }
    return () => {
      subscription.remove();
      linkEffectActive.current = false;
      // Effect replay keeps the queued link; a real unmount releases all remaining secrets.
      Promise.resolve().then(() => {
        if (!linkEffectActive.current) {
          resetLinks.current.dispose();
          takePasswordResetLink(lastLinkRequest.current);
        }
      });
    };
  }, []);

  useEffect(() => { resetLinks.current.flush(); }, [initialized, authenticated]);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (!authenticated) return undefined;
    if (!AppState.currentState || AppState.currentState === 'active') socketConnect();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') socketConnect();
      else socketClose(false);
    });
    return () => {
      subscription.remove();
      socketClose(false);
    };
  }, [authenticated, socketConnect, socketClose]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <CallsProvider>
        <BackgroundNotices navigationRef={navigationRef} />
        <NavigationContainer ref={navigationRef} theme={DefaultThemeBlue}
          onReady={() => { resetLinks.current.flush(); flushPendingNoticeOpen(); }}
          onStateChange={() => flushPendingNoticeOpen()}>
          <StatusBar barStyle="dark-content" />
          <Stack.Navigator
            screenOptions={{ headerShown: false }}
          >
            {!initialized ? (
              <Stack.Screen name="Splash" component={SplashScreen} />
            ) : !authenticated ? (
              <>
                <Stack.Screen name="SignIn" component={SignInScreen} />
                <Stack.Screen name="SignUp" component={SignUpScreen} />
              </>
            ) : (
              <>
                <Stack.Screen name="Home" component={HomeScreen} />
                <Stack.Screen name="Search" component={SearchScreen} />
                <Stack.Screen name="Messages" component={MessagesScreen} />
                <Stack.Screen name="CallDiagnostics" component={CallDiagnosticsScreen} />
                <Stack.Screen name="CallHistory" component={CallHistoryScreen} />
              </>
            )}
            <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
            <Stack.Screen name="ResetPassword" component={ResetPasswordScreen} />
          </Stack.Navigator>
        </NavigationContainer>
        <CallOverlay />
        </CallsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}


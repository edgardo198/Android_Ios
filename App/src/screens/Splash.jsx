import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { ActivityIndicator, Animated, StatusBar, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import Title from '../common/Title';

function SplashScreen( { navigation } ) {
    
    useLayoutEffect(() => {
        navigation.setOptions({
            headerShown: false
        })
    }, [navigation])

    const [fontsLoaded] = useFonts({
        'IBMPlexSans-Bold': require('../assets/fonts/IBMPlexSans-Bold.ttf'),
    });

    const translateY = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (fontsLoaded) {
            
            const animation = Animated.loop(
                Animated.sequence([
                    Animated.timing(translateY, {
                        toValue: 50, 
                        duration: 600, 
                        useNativeDriver: true,
                    }),
                    Animated.spring(translateY, {
                        toValue: 0, 
                        bounciness: 10, 
                        useNativeDriver: true,
                    }),
                ])
            );
            animation.start();
            return () => animation.stop();
        }
    }, [fontsLoaded, translateY]);

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar barStyle={'light-content'} />
            <Animated.View style={{ transform: [{ translateY }] }}>
                <Title fontLoaded={fontsLoaded} />
            </Animated.View>
            <ActivityIndicator color="#FFFFFF" style={styles.progress} accessibilityLabel="Cargando Mensajeria" />
            <Text style={styles.hint}>Abriendo tu cuenta…</Text>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0078D7', 
        alignItems: 'center',
        justifyContent: 'center',
    },
    progress: { marginTop: 24 },
    hint: { color: '#FFFFFF', marginTop: 12, fontSize: 16 },
});

export default SplashScreen;












import React from 'react';
import { Text, StyleSheet } from 'react-native';

function Title({ fontLoaded = false }) {
    return (
        <Text style={[styles.title, fontLoaded && styles.customFont]}>
            Mensajeria
        </Text>
    );
}

const styles = StyleSheet.create({
    title: {
        color: '#ffffff',
        textAlign: 'center',
        fontSize: 50,
        fontWeight: '700',
        marginTop: 0, 
    },
    customFont: { fontFamily: 'IBMPlexSans-Bold', fontWeight: 'normal' },
});

export default Title;



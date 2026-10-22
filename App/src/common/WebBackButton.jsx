import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { FontAwesomeIcon } from '@fortawesome/react-native-fontawesome';

function WebBackButton({ navigation, fallbackRoute, label = 'Volver', style }) {
  if (Platform.OS !== 'web') {
    return null;
  }

  const handlePress = () => {
    if (navigation?.canGoBack?.()) {
      navigation.goBack();
      return;
    }

    if (fallbackRoute) {
      navigation?.navigate?.(fallbackRoute);
      return;
    }

    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
    }
  };

  return (
    <View style={[styles.container, style]}>
      <TouchableOpacity style={styles.button} onPress={handlePress} accessibilityRole="button" accessibilityLabel={label}>
        <FontAwesomeIcon icon="arrow-left" size={16} color="#0b4f7a" />
        <Text style={styles.text}>{label}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'flex-start',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#dff2ff',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  text: {
    marginLeft: 8,
    color: '#0b4f7a',
    fontSize: 14,
    fontWeight: '700',
  },
});

export default WebBackButton;

import React from 'react';
import { Keyboard, Platform, TouchableWithoutFeedback, View } from 'react-native';

function DismissKeyboardView({ children, style }) {
  if (Platform.OS === 'web') {
    return <View style={style}>{children}</View>;
  }

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <View style={style}>{children}</View>
    </TouchableWithoutFeedback>
  );
}

export default DismissKeyboardView;

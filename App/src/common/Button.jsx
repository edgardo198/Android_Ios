import { Text, TouchableOpacity, View } from 'react-native';
import styles from '../Styles/styles';

function Button({ title, onPress, disabled = false, style, textStyle }) {
  return (
    <View style={styles.buttonContainer}>
      <TouchableOpacity
        activeOpacity={0.85}
        style={[styles.button, disabled && styles.buttonDisabled, style]}
        onPress={onPress}
        disabled={disabled}
      >
        <Text style={[styles.buttonText, textStyle]}>{title}</Text>
      </TouchableOpacity>
    </View>
  );
}

export default Button;

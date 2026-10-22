import { Text, TextInput, View } from 'react-native';
import styles from '../Styles/styles';

function Input({
  title,
  labelStyle,
  inputStyle,
  placeholder,
  value,
  error,
  setValue,
  setError,
  secureTextEntry = false,
  autoCapitalize = 'sentences',
  autoCorrect = true,
  autoComplete,
  textContentType,
  keyboardType = 'default',
  returnKeyType = 'done',
  onSubmitEditing,
  blurOnSubmit,
  inputRef,
  autoFocus = false,
  disabled = false,
}) {
  const borderColor = error ? '#ff7c80' : 'white';

  return (
    <View style={styles.inputContainer}>
      <Text style={[styles.inputLabel, labelStyle, error && styles.inputLabelError]}>
        {error || title}
      </Text>
      <TextInput
        ref={inputRef}
        style={[
          styles.textInput,
          { borderColor },
          inputStyle,
          disabled && styles.textInputDisabled,
        ]}
        placeholder={placeholder || title}
        placeholderTextColor="#aaa"
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        autoComplete={autoComplete}
        textContentType={textContentType}
        keyboardType={keyboardType}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        blurOnSubmit={blurOnSubmit}
        autoFocus={autoFocus}
        editable={!disabled}
        value={value}
        onChangeText={(text) => {
          setValue?.(text);
          if (error) {
            setError?.('');
          }
        }}
      />
    </View>
  );
}

export default Input;

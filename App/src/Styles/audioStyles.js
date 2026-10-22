import { StyleSheet } from 'react-native';

export default StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    minWidth: 0,
    gap: 12,
  },
  button: {
    width: 48,
    height: 48,
    flexShrink: 0,
    borderRadius: 24,
    backgroundColor: '#155EA0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.65,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#163B5D',
  },
  slider: {
    width: '100%',
    height: 32,
  },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeText: {
    color: '#36566F',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  errorText: {
    color: '#8A3030',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
});


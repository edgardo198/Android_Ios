import React, { useEffect, useRef, useState, memo } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform } from 'react-native';
import { useTypingAnimationMode } from '../../core/typingAnimation';

const MessageTypingAnimation = memo(({ delay = 0 }) => {
  const y = useRef(new Animated.Value(0)).current;
  const mode = useTypingAnimationMode();
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    let preferenceChanged = false;
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled?.() ?? false)
      .then((enabled) => { if (mounted && !preferenceChanged) setReduceMotion(enabled); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (enabled) => {
      preferenceChanged = true;
      if (mounted) setReduceMotion(enabled);
    });
    return () => { mounted = false; subscription?.remove(); };
  }, []);
  const animate = mode === 'on' || (mode === 'system' && !reduceMotion);
  useEffect(() => {
    y.setValue(0);
    if (!animate) return undefined;
    // A single native timing loops without waiting for JS callbacks between bumps.
    const animation = Animated.loop(Animated.timing(y, {
      toValue: 1,
      duration: 1000,
      easing: Easing.linear,
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    }));
    animation.start();
    return () => animation.stop();
  }, [animate, y]);
  const phase = Math.max(0, Math.min(200, delay)) / 1000;
  const translateY = y.interpolate({
    inputRange: phase ? [0, phase, phase + 0.2, phase + 0.4, 1] : [0, 0.2, 0.4, 1],
    outputRange: phase ? [0, 0, -8, 0, 0] : [0, -8, 0, 0],
    extrapolate: 'clamp',
  });
  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        marginHorizontal: 1.5,
        borderRadius: 4,
        backgroundColor: '#606060',
        transform: [{ translateY }],
      }}
    />
  );
});

export default MessageTypingAnimation;

import React, { useEffect, useRef, memo } from 'react';
import { Animated } from 'react-native';

const RecordingAnimation = memo(() => {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.5,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [scale]);
  return (
    <Animated.View
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: 'red',
        transform: [{ scale }],
        marginLeft: 10,
      }}
    />
  );
});

export default RecordingAnimation;

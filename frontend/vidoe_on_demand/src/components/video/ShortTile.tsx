import { useRouter } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { PressableScale } from '@/components/ui/PressableScale';
import { RemoteImage } from '@/components/ui/RemoteImage';
import { AppText } from '@/components/ui/Text';
import { colors, radii, spacing } from '@/css';
import type { VideoCardData } from '@/types/video';
import { formatCount } from '@/utils/format';

/** A vertical (9:16) tile for a Short, used in two-column grids. */
export const ShortTile = memo(({ video, style }: { video: VideoCardData; style?: StyleProp<ViewStyle> }) => {
  const router = useRouter();
  return (
    <PressableScale
      style={[styles.root, style]}
      accessibilityRole='button'
      accessibilityLabel={`${video.title}, ${formatCount(video.viewCount)} views`}
      onPress={() =>
        router.push({ pathname: '/video/[id]', params: { id: video.id } })
      }
    >
      <View style={styles.thumb}>
        {video.thumbnailUrl ? (
          <RemoteImage
            source={{ uri: video.thumbnailUrl }}
            style={StyleSheet.absoluteFill}
            contentFit='cover'
            accessibilityIgnoresInvertColors
          />
        ) : null}
      </View>
      <AppText variant='bodySmall' numberOfLines={1} style={styles.title}>
        {video.title}
      </AppText>
      <AppText variant='caption' color='muted'>
        {formatCount(video.viewCount)} views
      </AppText>
    </PressableScale>
  );
});
ShortTile.displayName = 'ShortTile';

const styles = StyleSheet.create({
  root: { flex: 1, maxWidth: '50%', gap: spacing.xs },
  thumb: {
    width: '100%',
    aspectRatio: 9 / 16,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.surface.glassMedium,
  },
  title: { paddingTop: spacing.xs },
});

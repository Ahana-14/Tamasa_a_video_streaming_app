import { useRouter } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { PressableScale } from '@/components/ui/PressableScale';
import { AppText } from '@/components/ui/Text';
import { colors, radii, spacing } from '@/css';
import type { VideoCardData } from '@/types/video';
import { formatCount } from '@/utils/format';
import { Thumbnail } from './Thumbnail';
import { videoA11yLabel } from '@/lib/a11y/videoLabel';

type Props = { video: VideoCardData; rank: number };

// Compact card for the horizontal Trending row. Width scales with the screen so the next card peeks in.
export const TrendingCard = memo(({ video, rank }: Props) => {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(300, Math.round(width * 0.7));

  return (
    <PressableScale
      style={{ width: cardWidth }}
      accessibilityRole='button'
      accessibilityLabel={videoA11yLabel(video, `Trending number ${rank}`)}
      onPress={() =>
        router.push({ pathname: '/video/[id]', params: { id: video.id } })
      }
    >
      <Thumbnail
        uri={video.thumbnailUrl}
        durationMs={video.durationMs}
        radius='lg'
      >
        <View style={styles.rank}>
          <AppText variant='label'>#{rank}</AppText>
        </View>
      </Thumbnail>
      <View style={styles.text}>
        <AppText variant='title' numberOfLines={1}>
          {video.title}
        </AppText>
        <AppText variant='bodySmall' color='secondary' numberOfLines={1}>
          {video.creator.name} · {formatCount(video.viewCount)} views
        </AppText>
      </View>
    </PressableScale>
  );
});
TrendingCard.displayName = 'TrendingCard';

const styles = StyleSheet.create({
  text: { gap: spacing.xs, paddingTop: spacing.sm },
  rank: {
    position: 'absolute',
    left: spacing.sm,
    top: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.overlay.scrimStrong,
  },
});

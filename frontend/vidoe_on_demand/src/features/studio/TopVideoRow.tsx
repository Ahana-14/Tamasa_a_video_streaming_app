import { RemoteImage as Image } from '@/components/ui/RemoteImage';
import { StyleSheet, View } from 'react-native';
import { PressableScale } from '@/components/ui/PressableScale';
import { AppText } from '@/components/ui/Text';
import { colors, radii, spacing } from '@/css';
import type { TopVideo } from '@/types/studio';
import { formatCount } from '@/utils/format';

type Props = {
  video: TopVideo;
  rank: number;
  onPress: (video: TopVideo) => void;
};

export const TopVideoRow = ({ video, rank, onPress }: Props) => (
  <PressableScale
    onPress={() => onPress(video)}
    accessibilityRole='button'
    accessibilityLabel={`${rank}. ${video.title}. ${video.viewCount} views, ${video.likeCount} likes, ${video.commentCount} comments. Open analytics.`}
    style={styles.row}
  >
    <AppText variant='title' color='muted' style={styles.rank}>
      {rank}
    </AppText>
    <View style={styles.thumb}>
      {video.thumbnailUrl ? (
        <Image
          source={{ uri: video.thumbnailUrl }}
          style={StyleSheet.absoluteFill}
          contentFit='cover'
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
    <View style={styles.meta}>
      <AppText variant='label' numberOfLines={1}>
        {video.title}
      </AppText>
      <AppText variant='bodySmall' color='secondary'>
        {formatCount(video.viewCount)} views · {formatCount(video.likeCount)}{' '}
        likes · {formatCount(video.commentCount)} comments
      </AppText>
    </View>
  </PressableScale>
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rank: { width: spacing.xl, textAlign: 'center' },
  thumb: {
    width: 96,
    aspectRatio: 16 / 9,
    borderRadius: radii.sm,
    overflow: 'hidden',
    backgroundColor: colors.surface.glassMedium,
  },
  meta: { flex: 1, gap: spacing.xs },
});

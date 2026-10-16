import { useRouter } from 'expo-router';
import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { PressableScale } from '@/components/ui/PressableScale';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { AppText } from '@/components/ui/Text';
import { colors, radii, spacing } from '@/css';
import type { VideoCardData } from '@/types/video';
import { formatCount, formatRelativeTime } from '@/utils/format';
import { Thumbnail } from './Thumbnail';
import { videoA11yLabel } from '@/lib/a11y/videoLabel';

// Structural width of the thumbnail column; the text takes the rest.
const THUMB_WIDTH = 150;

type Props = {
  video: VideoCardData;
  rank?: number;
  /** 0-100. Draws a resume bar over the thumbnail. */
  progressPercent?: number;
  /** Optional control at the far right (e.g. a remove button). */
  trailing?: ReactNode;
};

export const VideoRow = memo(
  ({ video, rank, progressPercent, trailing }: Props) => {
    const router = useRouter();
    const meta = [
      `${formatCount(video.viewCount)} views`,
      formatRelativeTime(video.publishedAt),
    ]
      .filter(Boolean)
      .join(' · ');

    return (
      <View style={styles.wrap}>
        <PressableScale
          style={styles.row}
          accessibilityRole='button'
          accessibilityLabel={videoA11yLabel(video, rank ? `Number ${rank}` : undefined)}
          onPress={() =>
            router.push({ pathname: '/video/[id]', params: { id: video.id } })
          }
        >
          <View style={{ width: THUMB_WIDTH }}>
            <Thumbnail
              uri={video.thumbnailUrl}
              durationMs={video.durationMs}
              radius='md'
            >
              {rank ? (
                <View style={styles.rank}>
                  <AppText variant='label'>#{rank}</AppText>
                </View>
              ) : null}
              {progressPercent ? (
                <ProgressBar percent={progressPercent} overlay />
              ) : null}
            </Thumbnail>
          </View>
          <View style={styles.text}>
            <AppText variant='title' numberOfLines={1}>
              {video.title}
            </AppText>
            <AppText variant='bodySmall' color='secondary' numberOfLines={1}>
              {video.creator.name}
              {video.type === 'SHORT_FORM' ? ' · Short' : ''}
            </AppText>
            <AppText variant='caption' color='muted' numberOfLines={1}>
              {meta}
            </AppText>
          </View>
        </PressableScale>
        {trailing}
      </View>
    );
  },
);
VideoRow.displayName = 'VideoRow';

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  row: { flex: 1, flexDirection: 'row', gap: spacing.md },
  text: { flex: 1, gap: spacing.xs, justifyContent: 'center' },
  rank: {
    position: 'absolute',
    left: spacing.xs,
    top: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.overlay.scrimStrong,
  },
});

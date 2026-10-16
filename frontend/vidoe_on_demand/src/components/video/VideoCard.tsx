import { useRouter } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar } from '@/components/ui/Avatar';
import { PressableScale } from '@/components/ui/PressableScale';
import { AppText } from '@/components/ui/Text';
import { spacing } from '@/css';
import type { VideoCardData } from '@/types/video';
import { formatCount, formatRelativeTime } from '@/utils/format';
import { Thumbnail } from './Thumbnail';
import { videoA11yLabel } from '@/lib/a11y/videoLabel';

type Props = {
  video: VideoCardData;
  /** On the creator's own page the avatar and name would just reopen the same page, so they stay plain. */
  hideCreator?: boolean;
};

// Long-form feed card. Thumbnail and title open the video; the avatar and the creator's name open the channel.
export const VideoCard = memo(({ video, hideCreator = false }: Props) => {
  const router = useRouter();
  const username = video.creator.username;
  const canOpenChannel = Boolean(username) && !hideCreator;
  const openChannel = () =>
    username && router.push({ pathname: '/creator/[username]', params: { username } });
  const openVideo = () => router.push({ pathname: '/video/[id]', params: { id: video.id } });
  const stats = [`${formatCount(video.viewCount)} views`, formatRelativeTime(video.publishedAt)]
    .filter(Boolean)
    .join(' · ');

  return (
    <View>
      <PressableScale accessibilityRole='button' accessibilityLabel={videoA11yLabel(video)} onPress={openVideo}>
        <Thumbnail uri={video.thumbnailUrl} durationMs={video.durationMs} />
      </PressableScale>
      <View style={styles.meta}>
        <PressableScale
          disabled={!canOpenChannel}
          accessibilityRole='button'
          accessibilityLabel={`Open ${video.creator.name}'s channel`}
          onPress={openChannel}
        >
          <Avatar uri={video.creator.avatarUrl} name={video.creator.name} size='md' />
        </PressableScale>
        <PressableScale style={styles.text} accessibilityRole='button' accessibilityLabel={videoA11yLabel(video)} onPress={openVideo}>
          <AppText variant='title' numberOfLines={1}>
            {video.title}
          </AppText>
          <AppText variant='bodySmall' color='secondary' numberOfLines={1}>
            <AppText
              variant='bodySmall'
              color='secondary'
              onPress={canOpenChannel ? openChannel : undefined}
              accessible={false}
            >
              {video.creator.name}
            </AppText>
            {` · ${stats}`}
          </AppText>
        </PressableScale>
      </View>
    </View>
  );
});
VideoCard.displayName = 'VideoCard';

const styles = StyleSheet.create({
  // Avatar is centred against the title + info lines (22 + 19 dp of text), so the three line up.
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingTop: spacing.md },
  text: { flex: 1, gap: spacing.xs },
});

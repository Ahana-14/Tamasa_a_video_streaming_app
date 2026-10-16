import { Ionicons } from '@expo/vector-icons';
import { RemoteImage as Image } from '@/components/ui/RemoteImage';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { GlassSurface } from '@/components/ui/GlassSurface';
import { PressableScale } from '@/components/ui/PressableScale';
import { AppText } from '@/components/ui/Text';
import { colors, radii, spacing } from '@/css';
import { isHdPending } from '@/lib/hdPolling';
import type { MyVideo } from '@/types/creatorVideo';
import { formatDuration, formatRelativeTime } from '@/utils/format';
import { describeStatus } from './videoStatus';

type Props = {
  video: MyVideo;
  onPublish: (video: MyVideo) => void;
  onEdit: (video: MyVideo) => void;
  onAnalytics: (video: MyVideo) => void;
};

const toneColor = {
  primary: colors.text.primary,
  secondary: colors.text.secondary,
  muted: colors.text.muted,
  error: colors.status.error,
} as const;

export const MyVideoRow = ({
  video,
  onPublish,
  onEdit,
  onAnalytics,
}: Props) => {
  const router = useRouter();
  const status = describeStatus(video);
  // The owner can open their own private video, as soon as it can be watched.
  const watchable = video.status === 'READY' || video.status === 'PUBLISHED';

  // The three-dots menu: one small dropdown anchored under the button, instead of a row of buttons per video.
  const dotsRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );
  const openMenu = () =>
    dotsRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({
        top: y + height + spacing.xs,
        right: Math.max(spacing.md, Dimensions.get('window').width - (x + width)),
      });
    });
  const closeMenu = () => setAnchor(null);
  const run = (action: (video: MyVideo) => void) => {
    closeMenu();
    action(video);
  };

  const items: { key: string; label: string; icon: keyof typeof Ionicons.glyphMap; accent?: boolean; onPress: () => void }[] = [
    ...(video.status === 'READY'
      ? [{ key: 'publish', label: 'Publish', icon: 'cloud-upload-outline' as const, accent: true, onPress: () => run(onPublish) }]
      : []),
    ...(video.status === 'PUBLISHED'
      ? [{ key: 'visibility', label: 'Visibility', icon: 'eye-outline' as const, onPress: () => run(onPublish) }]
      : []),
    ...(watchable
      ? [{ key: 'analytics', label: 'Analytics', icon: 'bar-chart-outline' as const, onPress: () => run(onAnalytics) }]
      : []),
    { key: 'edit', label: 'Edit', icon: 'create-outline' as const, onPress: () => run(onEdit) },
  ];

  return (
    <View style={styles.row}>
      <PressableScale
        disabled={!watchable}
        onPress={() => router.push(`/video/${video.id}`)}
        accessibilityRole='button'
        accessibilityLabel={`${video.title}. ${status.label}`}
        style={styles.main}
      >
        <View style={styles.thumb}>
          {video.thumbnailUrl ? (
            <Image
              source={{ uri: video.thumbnailUrl }}
              style={StyleSheet.absoluteFill}
              contentFit='cover'
              accessibilityIgnoresInvertColors
            />
          ) : null}
          {video.durationSec != null ? (
            <View style={styles.duration}>
              <AppText variant='caption'>
                {formatDuration(video.durationSec * 1000)}
              </AppText>
            </View>
          ) : null}
        </View>

        <View style={styles.meta}>
          <AppText variant='label' numberOfLines={1}>
            {video.title}
          </AppText>
          <View style={styles.statusRow}>
            <Ionicons
              name={status.icon}
              size={14}
              color={toneColor[status.tone]}
            />
            <AppText variant='bodySmall' color={status.tone}>
              {status.label}
            </AppText>
          </View>
          {isHdPending(video) ? (
            <AppText variant='caption' color='muted'>
              HD processing…
            </AppText>
          ) : null}
          <AppText variant='caption' color='muted'>
            {formatRelativeTime(video.publishedAt ?? video.createdAt)}
          </AppText>
        </View>
      </PressableScale>

      <View ref={dotsRef} collapsable={false}>
        <GlassIconButton
          icon='ellipsis-vertical'
          label={`More options for ${video.title}`}
          variant='plain'
          size='sm'
          onPress={openMenu}
        />
      </View>

      <Modal
        transparent
        visible={anchor != null}
        animationType='fade'
        statusBarTranslucent
        onRequestClose={closeMenu}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={closeMenu}
          accessibilityLabel='Close menu'
        />
        {anchor ? (
          <GlassSurface
            variant='strong'
            radius='md'
            style={[styles.menu, { top: anchor.top, right: anchor.right }]}
          >
            {items.map((item) => (
              <Pressable
                key={item.key}
                onPress={item.onPress}
                style={styles.menuItem}
                accessibilityRole='menuitem'
              >
                <Ionicons
                  name={item.icon}
                  size={18}
                  color={item.accent ? colors.accent.text : colors.text.secondary}
                />
                <AppText variant='title' color={item.accent ? 'accent' : 'primary'}>
                  {item.label}
                </AppText>
              </Pressable>
            ))}
          </GlassSurface>
        ) : null}
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  main: { flex: 1, flexDirection: 'row', gap: spacing.md },
  thumb: {
    width: 128,
    aspectRatio: 16 / 9,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.surface.glassMedium,
  },
  duration: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.overlay.scrimStrong,
  },
  meta: { flex: 1, gap: spacing.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  menu: { position: 'absolute', minWidth: 170 },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 44,
  },
});

import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { PressableScale } from '@/components/ui/PressableScale';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { AppText } from '@/components/ui/Text';
import { Thumbnail } from '@/components/video';
import { colors, layout, spacing } from '@/css';
import type { DownloadRecord } from '@/lib/downloads/types';
import { formatBytes } from '@/utils/format';

// Structural width of the thumbnail column; the text takes the rest.
const THUMB_WIDTH = 130;

type Props = {
  record: DownloadRecord;
  onOpen: (record: DownloadRecord) => void;
  onCancel: (record: DownloadRecord) => void;
  onRetry: (record: DownloadRecord) => void;
  onDelete: (record: DownloadRecord) => void;
};

const statusLine = (r: DownloadRecord): string => {
  switch (r.status) {
    case 'completed':
      return `${r.creatorName}${r.sizeBytes ? ` · ${formatBytes(r.sizeBytes)}` : ''}`;
    case 'downloading':
      return `Downloading ${Math.round(r.progress * 100)}%`;
    case 'queued':
      return 'Waiting to start…';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return r.error ?? 'Failed';
  }
};

const IconButton = ({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) => (
  <Pressable
    onPress={onPress}
    hitSlop={8}
    style={styles.iconButton}
    accessibilityRole='button'
    accessibilityLabel={label}
  >
    <Ionicons name={icon} size={22} color={colors.text.secondary} />
  </Pressable>
);

export const DownloadRow = memo(
  ({ record, onOpen, onCancel, onRetry, onDelete }: Props) => {
    const done = record.status === 'completed';
    const busy = record.status === 'downloading' || record.status === 'queued';

    return (
      <View style={styles.wrap}>
        <PressableScale
          style={styles.row}
          disabled={!done}
          accessibilityRole='button'
          accessibilityLabel={`${record.title}. ${statusLine(record)}`}
          accessibilityHint={done ? 'Plays offline' : undefined}
          onPress={() => onOpen(record)}
        >
          <View style={{ width: THUMB_WIDTH }}>
            <Thumbnail
              uri={record.thumbnailLocalUri}
              durationMs={record.durationMs}
              radius='md'
            >
              {record.status === 'downloading' ? (
                <ProgressBar percent={record.progress * 100} overlay />
              ) : null}
            </Thumbnail>
          </View>
          <View style={styles.text}>
            <AppText variant='title' numberOfLines={1}>
              {record.title}
            </AppText>
            <AppText
              variant='bodySmall'
              color={record.status === 'failed' ? 'error' : 'secondary'}
              numberOfLines={2}
            >
              {statusLine(record)}
            </AppText>
          </View>
        </PressableScale>

        {busy ? (
          <IconButton
            icon='close'
            label={`Cancel download of ${record.title}`}
            onPress={() => onCancel(record)}
          />
        ) : null}
        {record.status === 'failed' || record.status === 'cancelled' ? (
          <IconButton
            icon='refresh'
            label={`Retry ${record.title}`}
            onPress={() => onRetry(record)}
          />
        ) : null}
        {!busy ? (
          <IconButton
            icon='trash-outline'
            label={`Delete ${record.title}`}
            onPress={() => onDelete(record)}
          />
        ) : null}
      </View>
    );
  },
);
DownloadRow.displayName = 'DownloadRow';

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  row: { flex: 1, flexDirection: 'row', gap: spacing.md },
  text: { flex: 1, gap: spacing.xs, justifyContent: 'center' },
  iconButton: {
    minWidth: layout.minTouchTarget,
    minHeight: layout.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

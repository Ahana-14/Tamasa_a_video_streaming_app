import { haptics } from '@/lib/haptics';
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isApiError } from '@/api/ApiError';
import { GlassButton } from '@/components/ui/GlassButton';
import { PressableScale } from '@/components/ui/PressableScale';
import { AppText } from '@/components/ui/Text';
import { colors, radii, spacing } from '@/css';
import { usePublishVideo } from '@/hooks/mutations/usePublishVideo';
import { describeError } from '@/lib/errors/describeError';
import { toast } from '@/lib/toast';
import type { MyVideo, Visibility } from '@/types/creatorVideo';

const OPTIONS: { value: Visibility; label: string; hint: string }[] = [
  {
    value: 'PUBLIC',
    label: 'Public',
    hint: 'Anyone can find and watch it. Your followers get a notification.',
  },
  {
    value: 'UNLISTED',
    label: 'Unlisted',
    hint: 'Hidden from feeds and search.',
  },
  { value: 'PRIVATE', label: 'Private', hint: 'Only you can see it.' },
];

type Props = { video: MyVideo; onClose: () => void };

export const PublishSheet = ({ video, onClose }: Props) => {
  const insets = useSafeAreaInsets();
  const publish = usePublishVideo();
  const published = video.status === 'PUBLISHED';

  // Start from what's live, or what the creator asked for at upload time.
  const [selected, setSelected] = useState<Visibility>(
    published ? video.visibility : (video.requestedVisibility ?? 'PUBLIC'),
  );
  const [error, setError] = useState<string | null>(null);

  const unchanged = published && selected === video.visibility;

  const submit = () => {
    setError(null);
    publish.mutate(
      { video, visibility: selected },
      {
        onSuccess: () => {
          haptics.success();
          toast.success(
            published
              ? 'Visibility updated'
              : selected === 'PUBLIC'
                ? 'Your video is live'
                : 'Video published',
          );
          onClose();
        },
        onError: (e) =>
          setError(isApiError(e) ? e.message : describeError(e).message),
      },
    );
  };

  return (
    <Modal
      transparent
      animationType='fade'
      visible
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root} accessibilityViewIsModal>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole='button'
          accessibilityLabel='Close'
        />
        <View
          style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}
        >
          <AppText variant='title'>
            {published ? 'Change visibility' : 'Publish video'}
          </AppText>
          <AppText variant='bodySmall' color='secondary' numberOfLines={1}>
            {video.title}
          </AppText>

          <View style={styles.options} accessibilityRole='radiogroup'>
            {OPTIONS.map((o) => {
              const on = selected === o.value;
              return (
                <PressableScale
                  key={o.value}
                  onPress={() => setSelected(o.value)}
                  disabled={publish.isPending}
                  accessibilityRole='radio'
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${o.label}. ${o.hint}`}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <Ionicons
                    name={on ? 'radio-button-on' : 'radio-button-off'}
                    size={22}
                    color={on ? colors.text.primary : colors.text.muted}
                  />
                  <View style={styles.optionText}>
                    <AppText variant='label'>{o.label}</AppText>
                    <AppText variant='bodySmall' color='muted'>
                      {o.hint}
                    </AppText>
                  </View>
                </PressableScale>
              );
            })}
          </View>

          {!published ? (
            <AppText variant='caption' color='muted'>
              You don't need to wait for HD. Higher qualities are added
              automatically once they finish.
            </AppText>
          ) : null}

          {error ? (
            <AppText
              variant='bodySmall'
              color='error'
              accessibilityLiveRegion='polite'
            >
              {error}
            </AppText>
          ) : null}

          <GlassButton
            label={
              published
                ? 'Save'
                : selected === 'PUBLIC'
                  ? 'Publish'
                  : `Publish as ${selected.toLowerCase()}`
            }
            variant='primary'
            size='lg'
            fullWidth
            loading={publish.isPending}
            disabled={unchanged}
            onPress={submit}
          />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.overlay.scrimStrong,
  },
  sheet: {
    gap: spacing.md,
    padding: spacing.lg,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    backgroundColor: colors.background.primary,
  },
  options: { gap: spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.surface.glassMedium,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionOn: { borderColor: colors.text.primary },
  optionText: { flex: 1, gap: 2 },
});

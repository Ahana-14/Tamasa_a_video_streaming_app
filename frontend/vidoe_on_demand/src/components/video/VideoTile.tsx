import { useRouter } from "expo-router";
import { memo } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AppText } from "@/components/ui/Text";
import { spacing } from "@/css";
import type { VideoCardData } from "@/types/video";
import { Thumbnail } from "./Thumbnail";
import { videoA11yLabel } from '@/lib/a11y/videoLabel';

type Props = { video: VideoCardData; progressPercent?: number };

export const VideoTile = memo(({ video, progressPercent }: Props) => {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const tileWidth = Math.min(240, Math.round(width * 0.58));

  return (
    <PressableScale
      style={{ width: tileWidth }}
      accessibilityRole="button"
      accessibilityLabel={videoA11yLabel(video)}
      onPress={() => router.push({ pathname: "/video/[id]", params: { id: video.id } })}
    >
      <Thumbnail uri={video.thumbnailUrl} durationMs={video.durationMs} radius="lg">
        {progressPercent ? <ProgressBar percent={progressPercent} overlay /> : null}
      </Thumbnail>
      <View style={styles.text}>
        <AppText variant="title" numberOfLines={1}>
          {video.title}
        </AppText>
        <AppText variant="bodySmall" color="secondary" numberOfLines={1}>
          {video.creator.name}
        </AppText>
      </View>
    </PressableScale>
  );
});
VideoTile.displayName = "VideoTile";

const styles = StyleSheet.create({ text: { gap: spacing.xs, paddingTop: spacing.sm } });
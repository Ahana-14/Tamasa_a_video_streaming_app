import * as ImagePicker from 'expo-image-picker';
import * as FS from '@/lib/downloads/fs';

export type PickedVideo = {
  uri: string;
  name: string;
  contentType: string;
  /** Without the dot. */
  extension: string;
  durationSec: number | null;
  sizeBytes: number | null;
};

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  '3gp': 'video/3gpp',
};
const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
);

const UPLOAD_DIR = `${FS.documentDirectory}pending-uploads/`;

/**
 * The picker leaves its copy in the cache folder, which Android may empty at any moment (a big video makes that likely).
 * Move it, a rename that costs nothing, to a folder the system leaves alone until we delete it.
 */
const keepSafe = async (uri: string, extension: string): Promise<string> => {
  try {
    await FS.makeDirectoryAsync(UPLOAD_DIR, { intermediates: true });
    // Anything left from an earlier pick (an upload that was never finished) is no longer needed.
    for (const old of await FS.readDirectoryAsync(UPLOAD_DIR)) await FS.deleteAsync(`${UPLOAD_DIR}${old}`, { idempotent: true });
    const target = `${UPLOAD_DIR}${Date.now()}.${extension}`;
    await FS.moveAsync({ from: uri, to: target });
    return target;
  } catch {
    return uri;
  }
};

/** Removes a video that was kept for upload (after it uploaded, or when it is replaced). Safe to call on any uri. */
export const discardPickedVideo = async (uri: string | null | undefined) => {
  if (!uri || !uri.startsWith(UPLOAD_DIR)) return;
  await FS.deleteAsync(uri, { idempotent: true }).catch(() => {});
};

/** Opens the library for a video. No editing step, so the original file is uploaded untouched. */
export const pickVideo = async (): Promise<PickedVideo | null> => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    allowsEditing: false,
  });
  if (result.canceled || !result.assets[0]) return null;

  const asset = result.assets[0];
  const fromName = asset.fileName?.split('.').pop()?.toLowerCase();
  const extension =
    (fromName && fromName.length <= 5 ? fromName : undefined) ??
    (asset.mimeType ? EXT_BY_MIME[asset.mimeType] : undefined) ??
    'mp4';

  return {
    uri: await keepSafe(asset.uri, extension),
    name: asset.fileName ?? `video.${extension}`,
    contentType: MIME_BY_EXT[extension] ?? asset.mimeType ?? 'video/mp4',
    extension,
    // expo-image-picker reports duration in milliseconds.
    durationSec: asset.duration != null ? asset.duration / 1000 : null,
    sizeBytes: asset.fileSize ?? null,
  };
};

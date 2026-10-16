import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { isApiError } from '@/api/ApiError';
import {
  completeVideoUpload,
  confirmThumbnail,
  initVideoUpload,
  refreshVideoUploadUrl,
  requestThumbnailUpload,
  type VideoUploadInput,
  type VideoUploadTicket,
} from '@/api/uploads';
import { useApi } from '@/lib/auth/useApi';
import type { PickedImage } from '@/lib/media/pickImage';
import type { PickedVideo } from '@/lib/media/pickVideo';
import { UploadCancelledError, UploadFileMissingError, uploadToBlob } from '@/lib/upload/blobUpload';
import { uploadInBlocks } from '@/lib/upload/blockUpload';

export type UploadPhase =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'thumbnail'
  | 'finalizing';

type Input = {
  video: PickedVideo;
  title: string;
  description: string;
  categoryId: string;
  thumbnail: PickedImage | null;
};

export type UploadResult =
  | { ok: true; videoId: string; thumbnailFailed: boolean }
  | { ok: false; error: string; cancelled: boolean };

// The upload link is renewed (cheap) whenever an attempt is picked up again; Azure keeps the blocks already sent for a
// week, so an attempt stays resumable long after its link expired. The backend discards unfinished uploads after 24 h.
const ATTEMPT_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const ATTEMPT_KEY = 'upload-attempt-v1';

type Attempt = {
  signature: string;
  ticket: VideoUploadTicket;
  createdAt: number;
  uploaded: boolean;
  thumbnailDone: boolean;
};

// Kept on the phone so an upload also resumes after the app was closed or the phone restarted.
const saveAttempt = (attempt: Attempt | null) => {
  const write = attempt
    ? AsyncStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt))
    : AsyncStorage.removeItem(ATTEMPT_KEY);
  void write.catch(() => {});
};
const loadAttempt = async (signature: string): Promise<Attempt | null> => {
  try {
    const raw = await AsyncStorage.getItem(ATTEMPT_KEY);
    const saved = raw ? (JSON.parse(raw) as Attempt) : null;
    return saved && saved.signature === signature && Date.now() - saved.createdAt < ATTEMPT_MAX_AGE_MS ? saved : null;
  } catch {
    return null;
  }
};

/**
 * init -> PUT the file -> (custom thumbnail) -> complete.
 * A failed attempt remembers how far it got, so "Try again" resumes instead of creating a duplicate video.
 */
export const useVideoUpload = () => {
  const api = useApi();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [progress, setProgress] = useState(0);
  const attempt = useRef<Attempt | null>(null);
  const abort = useRef<AbortController | null>(null);

  const onProgress = (fraction: number) => {
    // Avoid re-rendering hundreds of times a second.
    setProgress((prev) =>
      fraction - prev >= 0.01 || fraction >= 1 ? fraction : prev,
    );
  };

  const running = useRef(false);

  const run = async (input: Input): Promise<UploadResult> => {
    // A second tap (or call) while an upload is starting must not create a second video.
    if (running.current) return { ok: false, error: 'An upload is already in progress.', cancelled: true };
    running.current = true;
    const controller = new AbortController();
    abort.current = controller;
    const signal = controller.signal;

    // The same video + details means the same upload, even if the file was picked again after the app was closed.
    const signature = JSON.stringify([
      input.video.name,
      input.video.sizeBytes,
      input.title,
      input.description,
      input.categoryId,
      input.thumbnail ? 'custom' : 'auto',
    ]);

    try {
      let current: Attempt | null = attempt.current ?? (await loadAttempt(signature));
      if (current && current.signature !== signature) current = null;

      // An earlier attempt: get a fresh link for it. If the server no longer has that upload, start over.
      if (current && !current.uploaded) {
        try {
          current.ticket.uploadUrl = (await refreshVideoUploadUrl(api, current.ticket.videoId)).uploadUrl;
        } catch (error) {
          if (isApiError(error) && (error.status === 404 || error.status === 409 || error.status === 403)) current = null;
          else throw error;
        }
      }

      if (!current) {
        setPhase('preparing');
        setProgress(0);
        const ticket = await initVideoUpload(api, {
          title: input.title,
          description: input.description || undefined,
          categoryId: input.categoryId,
          fileExtension: input.video.extension,
          thumbnailSource: input.thumbnail ? 'CUSTOM' : 'AUTO',
        });
        current = { signature, ticket, createdAt: Date.now(), uploaded: false, thumbnailDone: false };
      }
      attempt.current = current;
      saveAttempt(current);
      const live = current;

      if (!current.uploaded) {
        setPhase('uploading');
        setProgress(0);
        await uploadInBlocks(current.ticket.uploadUrl, input.video.uri, {
          contentType: input.video.contentType,
          onProgress,
          signal,
          refreshUrl: async () => {
            live.ticket.uploadUrl = (await refreshVideoUploadUrl(api, live.ticket.videoId)).uploadUrl;
            return live.ticket.uploadUrl;
          },
        });
        current.uploaded = true;
        saveAttempt(current);
      }

      let thumbnailFailed = false;
      if (input.thumbnail && !current.thumbnailDone) {
        setPhase('thumbnail');
        try {
          const t = await requestThumbnailUpload(
            api,
            current.ticket.videoId,
            input.thumbnail.extension,
          );
          await uploadToBlob(t.uploadUrl, input.thumbnail.uri, {
            contentType: input.thumbnail.contentType,
            signal,
          });
          await confirmThumbnail(api, current.ticket.videoId, t.blobName);
          current.thumbnailDone = true;
          saveAttempt(current);
        } catch (error) {
          if (error instanceof UploadCancelledError) throw error;
          // The video matters more than its cover: carry on, the worker generates one automatically.
          thumbnailFailed = true;
        }
      }

      setPhase('finalizing');
      await completeVideoUpload(api, current.ticket.videoId);

      const videoId = current.ticket.videoId;
      attempt.current = null;
      saveAttempt(null);
      await qc.invalidateQueries({ queryKey: ['studio'] });
      return { ok: true, videoId, thumbnailFailed };
    } catch (error) {
      if (error instanceof UploadCancelledError) {
        attempt.current = null;
        saveAttempt(null);
        return { ok: false, error: 'Upload cancelled.', cancelled: true };
      }
      return {
        ok: false,
        error: isApiError(error)
          ? error.message
          : error instanceof UploadFileMissingError
            ? error.message
            : "The upload was interrupted. Your progress is saved: tap Try again and it continues where it stopped.",
        cancelled: false,
      };
    } finally {
      running.current = false;
      abort.current = null;
      setPhase('idle');
    }
  };

  const cancel = () => abort.current?.abort();

  return { run, cancel, phase, progress, busy: phase !== 'idle' };
};

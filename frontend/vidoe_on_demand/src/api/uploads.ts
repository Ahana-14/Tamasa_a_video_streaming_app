import type { Api } from './client';

const required = { auth: 'required' } as const;

export type VideoUploadInput = {
  title: string;
  description?: string;
  /** Optional. The upload screen no longer asks; visibility is chosen when publishing from Content. */
  visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  categoryId: string;
  /** Without the dot, e.g. "mp4". */
  fileExtension: string;
  thumbnailSource: 'AUTO' | 'CUSTOM';
};

export type VideoUploadTicket = {
  videoId: string;
  assetId: string;
  uploadUrl: string;
  blobPath: string;
};

export const initVideoUpload = (api: Api, body: VideoUploadInput) =>
  api.post<VideoUploadTicket>('/api/videos/init', body, required);

/** A fresh signed upload link for an unfinished upload (to resume after the connection dropped). */
export const refreshVideoUploadUrl = (api: Api, videoId: string) =>
  api.post<{ uploadUrl: string }>(`/api/videos/${videoId}/upload-url`, undefined, required);

export const completeVideoUpload = (api: Api, videoId: string) =>
  api.post(`/api/videos/${videoId}/complete`, undefined, required);

export const requestThumbnailUpload = (
  api: Api,
  videoId: string,
  fileExtension: string,
) =>
  api.post<{ uploadUrl: string; blobName: string }>(
    `/api/videos/${videoId}/thumbnail`,
    { fileExtension },
    required,
  );

export const confirmThumbnail = (api: Api, videoId: string, blobName: string) =>
  api.post(`/api/videos/${videoId}/thumbnail/confirm`, { blobName }, required);

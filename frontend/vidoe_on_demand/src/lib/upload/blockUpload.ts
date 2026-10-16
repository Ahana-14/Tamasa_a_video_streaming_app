import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import { UploadCancelledError, UploadFileMissingError } from './blobUpload';

/**
 * Resumable upload to Azure Blob Storage. The file goes up as numbered 4 MB blocks, a few at a time, and is assembled
 * at the end (Put Block List). Before sending anything we ask Azure which blocks it already holds from an earlier
 * attempt, so after a dropped connection (or a closed app) only the missing blocks are sent again.
 */
const BLOCK_SIZE = 4 * 1024 * 1024;
const PARALLEL = 3;
const MAX_TRIES = 8;

type Options = {
  contentType: string;
  /** 0..1 */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** A new signed link, used when the current one has expired. */
  refreshUrl: () => Promise<string>;
};

class LinkExpiredError extends Error {}

const blockId = (index: number) => btoa(String(index).padStart(6, '0')); // every id must be the same length

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export const uploadInBlocks = async (
  initialUrl: string,
  fileUri: string,
  { contentType, onProgress, signal, refreshUrl }: Options,
) => {
  const check = () => {
    if (signal?.aborted) throw new UploadCancelledError();
  };
  check();

  const file = new File(fileUri);
  if (!file.exists) throw new UploadFileMissingError();
  const size = file.size;
  if (!size) throw new UploadFileMissingError();
  const count = Math.ceil(size / BLOCK_SIZE);
  const lengthOf = (index: number) => Math.min(BLOCK_SIZE, size - index * BLOCK_SIZE);

  let url = initialUrl;
  const withQuery = (query: string) => `${url}&${query}`;

  /** One request, retried with a pause when the network fails; a new link is fetched when the old one expired. */
  const send = async (make: () => Promise<Response>, okStatuses: number[]) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      check();
      try {
        const res = await make();
        if (okStatuses.includes(res.status)) return res;
        if (res.status === 403) throw new LinkExpiredError();
        throw new Error(`status ${res.status}`);
      } catch (error) {
        check();
        lastError = error;
        if (error instanceof LinkExpiredError) {
          url = await refreshUrl();
          continue;
        }
        await sleep(Math.min(20_000, 1000 * 2 ** attempt), signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Upload failed');
  };

  // Which blocks does Azure already have? (404 = nothing uploaded yet.)
  const stored = new Map<string, number>();
  try {
    const res = await send(
      () => fetch(withQuery('comp=blocklist&blocklisttype=uncommitted'), { signal }),
      [200, 404],
    );
    if (res.status === 200) {
      const xml = await res.text();
      for (const m of xml.matchAll(/<Block><Name>([^<]+)<\/Name><Size>(\d+)<\/Size>/g)) {
        stored.set(m[1] as string, Number(m[2]));
      }
    }
  } catch (error) {
    if (error instanceof UploadCancelledError) throw error;
    // Could not ask: just send everything, which is always correct.
  }

  const pending: number[] = [];
  let done = 0;
  for (let i = 0; i < count; i++) {
    if (stored.get(blockId(i)) === lengthOf(i)) done += lengthOf(i);
    else pending.push(i);
  }
  onProgress?.(done / size);

  const handle = file.open();
  try {
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const index = pending[next++] as number;
        check();
        // Reading and moving the cursor happen together with no await between, so workers never interleave.
        handle.offset = index * BLOCK_SIZE;
        const bytes = handle.readBytes(lengthOf(index));
        await send(
          () =>
            fetch(withQuery(`comp=block&blockid=${encodeURIComponent(blockId(index))}`), {
              method: 'PUT',
              body: bytes,
              signal,
            }),
          [201],
        );
        done += bytes.length;
        onProgress?.(done / size);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, pending.length) }, worker));
  } finally {
    handle.close();
  }

  const list = `<?xml version="1.0" encoding="utf-8"?><BlockList>${Array.from(
    { length: count },
    (_, i) => `<Latest>${blockId(i)}</Latest>`,
  ).join('')}</BlockList>`;
  await send(
    () =>
      fetch(withQuery('comp=blocklist'), {
        method: 'PUT',
        body: list,
        headers: { 'Content-Type': 'application/xml', 'x-ms-blob-content-type': contentType },
        signal,
      }),
    [201],
  );
};

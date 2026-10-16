import {
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';

import {
  containers,
  sharedKeyCredential,
  type ContainerName,
} from '../config/azure';

export const AzureStorageService = {
  //async function to create a container if it doesn't exist
  createContainerIfNotExists: async (containerName: ContainerName) => {
    try {
      await containers[containerName].createIfNotExists();
    } catch (error) {
      throw new Error(
        `Failed to create/check container "${containerName}": ${error}`,
      );
    }
  },

  // Get a block blob client for a specific container and blob(file name )
  getBlockBlobClient: (containerName: ContainerName, blobName: string) =>
    containers[containerName].getBlockBlobClient(blobName),

  
  // Check if a blob exists in a specific container 
  blobExists: async (containerName: ContainerName, blobName: string) => {
    try {
      return await AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      ).exists();
    } catch (error) {
      throw new Error(
        `Failed to check existence of "${blobName}" in "${containerName}": ${error}`,
      );
    }
  },

  // Get properties of a blob in a specific container
  getBlobProperties: async (containerName: ContainerName, blobName: string) => {
    try {
      return await AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      ).getProperties();
    } catch (error) {
      throw new Error(
        `Failed to get properties of "${blobName}" in "${containerName}": ${error}`,
      );
    }
  },

  // Upload text content to a blob in a specific container
  uploadText: async (
    containerName: ContainerName,
    blobName: string,
    content: string,
  ) => {
    try {
      const blockBlobClient = AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      );
      await blockBlobClient.upload(content, Buffer.byteLength(content));
    } catch (error) {
      throw new Error(
        `Failed to upload "${blobName}" to "${containerName}": ${error}`,
      );
    }
  },
  
  // Same as uploadText, but stores a Content-Type (e.g. text/vtt for subtitle files).
  uploadTextTyped: async (
    containerName: ContainerName,
    blobName: string,
    content: string,
    contentType: string,
  ) => {
    try {
      const blockBlobClient = AzureStorageService.getBlockBlobClient(containerName, blobName);
      await blockBlobClient.upload(content, Buffer.byteLength(content), {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    } catch (error) {
      throw new Error(`Failed to upload "${blobName}" to "${containerName}": ${error}`);
    }
  },

  /**
   * Reads a small text blob back out of storage — used to fetch an
   * already-published master.m3u8 so an HD transcode job can amend it
   * (append its rung) instead of overwriting the whole file.
   */
  downloadText: async (containerName: ContainerName, blobName: string): Promise<string> => {
    try {
      const blockBlobClient = AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      );
      const buffer = await blockBlobClient.downloadToBuffer();
      return buffer.toString('utf-8');
    } catch (error) {
      throw new Error(
        `Failed to download text "${blobName}" from "${containerName}": ${error}`,
      );
    }
  },

  /**
   * Same as downloadText, but also returns the blob's current ETag — a
   * version fingerprint Azure updates on every write. Pairs with
   * uploadTextIfMatch() below to do a safe read-modify-write: the 1080p
   * and 1440p transcode jobs both amend the SAME master.m3u8, and can now
   * genuinely run at the same instant (see WORKER_CONCURRENCY), so a
   * plain read-then-write here has the exact same lost-update race we
   * already fixed once in Postgres — this is that same fix, applied to
   * blob storage instead of a database row.
   */
  downloadTextWithEtag: async (
    containerName: ContainerName,
    blobName: string,
  ): Promise<{ content: string; etag: string }> => {
    try {
      const blockBlobClient = AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      );
      const buffer = await blockBlobClient.downloadToBuffer();
      const properties = await blockBlobClient.getProperties();
      if (!properties.etag) {
        throw new Error('Blob has no ETag — cannot do a conditional update');
      }
      return { content: buffer.toString('utf-8'), etag: properties.etag };
    } catch (error: any) {
      if (error?.statusCode === 404) {
        const notFound = new Error(
          `Blob "${blobName}" does not exist yet in "${containerName}"`,
        );
        notFound.name = 'BlobNotFoundError';
        throw notFound;
      }
      throw new Error(
        `Failed to download text+ETag for "${blobName}" from "${containerName}": ${error}`,
      );
    }
  },

  /**
   * Creates a blob ONLY IF it doesn't already exist — Azure's `ifNoneMatch:
   * "*"` conditional. This is the counterpart to uploadTextIfMatch(): where
   * that one guards "amend an existing file safely", this one guards
   * "create a file for the first time safely" when two writers (e.g. the
   * TRANSCODE_STANDARD job and an HD rung's job, now genuinely concurrent
   * — see WORKER_CONCURRENCY) might both try to be the one who creates
   * master.m3u8. Whoever loses gets a distinguishable AlreadyExistsError
   * and should fall back to the read-then-amend path instead.
   */
  uploadTextIfNotExists: async (
    containerName: ContainerName,
    blobName: string,
    content: string,
  ) => {
    try {
      const blockBlobClient = AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      );
      await blockBlobClient.upload(content, Buffer.byteLength(content), {
        conditions: { ifNoneMatch: '*' },
      });
    } catch (error: any) {
      if (error?.statusCode === 409 || error?.statusCode === 412) {
        const exists = new Error(
          `Blob "${blobName}" in "${containerName}" was created by another writer first`,
        );
        exists.name = 'AlreadyExistsError';
        throw exists;
      }
      throw new Error(
        `Failed to create "${blobName}" in "${containerName}": ${error}`,
      );
    }
  },

  /**
   * Uploads ONLY IF the blob's ETag still matches what the caller read —
   * this is Azure's optimistic-concurrency guard, the blob-storage
   * equivalent of Postgres's "UPDATE ... WHERE version = X". If someone
   * else (the other HD rung's job) wrote to this blob in between our read
   * and our write, the ETag has changed, Azure rejects this upload with
   * HTTP 412 (Precondition Failed), and we throw a distinguishable
   * ConditionNotMetError the caller can catch and retry against a fresh
   * read — never silently overwriting the other writer's line.
   */
  uploadTextIfMatch: async (
    containerName: ContainerName,
    blobName: string,
    content: string,
    etag: string,
  ) => {
    try {
      const blockBlobClient = AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      );
      await blockBlobClient.upload(content, Buffer.byteLength(content), {
        conditions: { ifMatch: etag },
      });
    } catch (error: any) {
      if (error?.statusCode === 412) {
        const conflict = new Error(
          `ETag mismatch writing "${blobName}" in "${containerName}" — blob changed concurrently`,
        );
        conflict.name = 'ConditionNotMetError';
        throw conflict;
      }
      throw new Error(
        `Failed to conditionally upload "${blobName}" to "${containerName}": ${error}`,
      );
    }
  },

  // delete a blob from a specific container
  deleteBlob: async (containerName: ContainerName, blobName: string) => {
    try {
      await AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      ).deleteIfExists();
    } catch (error) {
      throw new Error(
        `Failed to delete "${blobName}" from "${containerName}": ${error}`,
      );
    }
  },

  // Generate a SAS URL for uploading a blob to a specific container
  generateUploadSasUrl: async (
    containerName: ContainerName,
    blobName: string,
    expiresInMinutes = 15,
  ) => {
    try {
      const blockBlobClient = AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      );
      const expiresOn = new Date(Date.now() + expiresInMinutes * 60 * 1000);

      const sas = generateBlobSASQueryParameters(
        {
          containerName: containers[containerName].containerName,
          blobName,
          // r: lets the app ask which blocks of an interrupted upload are already stored, so it sends only the rest
          permissions: BlobSASPermissions.parse('rcw'),
          startsOn: new Date(),
          expiresOn,
        },
        sharedKeyCredential,
      ).toString();

      return `${blockBlobClient.url}?${sas}`;
    } catch (error) {
      throw new Error(
        `Failed to generate upload SAS URL for "${blobName}" in "${containerName}": ${error}`,
      );
    }
  },
  

  // Generate a SAS URL for reading a blob from a specific container
  generateReadSasUrl: async (
    containerName: ContainerName,
    blobName: string,
    expiresInMinutes = 60,
  ) => {
    try {
      const blockBlobClient = AzureStorageService.getBlockBlobClient(
        containerName,
        blobName,
      );
      // Bucket the validity window so repeated requests return the SAME url for a while.
      // A fresh Date.now() on every call made every url unique, so clients re-downloaded every image.
      const bucketMs = 15 * 60 * 1000;
      const bucketStart = Math.floor(Date.now() / bucketMs) * bucketMs;
      const startsOn = new Date(bucketStart - 5 * 60 * 1000); // small back-dating tolerates clock skew
      const expiresOn = new Date(bucketStart + bucketMs + expiresInMinutes * 60 * 1000); // >= expiresInMinutes left

      const sas = generateBlobSASQueryParameters(
        {
          containerName: containers[containerName].containerName,
          blobName,
          permissions: BlobSASPermissions.parse('r'),
          startsOn,
          expiresOn,
        },
        sharedKeyCredential,
      ).toString();

      return `${blockBlobClient.url}?${sas}`;
    } catch (error) {
      throw new Error(
        `Failed to generate read SAS URL for "${blobName}" in "${containerName}": ${error}`,
      );
    }
  },
};

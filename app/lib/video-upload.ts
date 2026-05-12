// Resumable (tus-protocol) video uploads to Supabase Storage.
//
// Why this exists (B14): Safari aggressively kills long-running fetch()
// uploads. Supabase's standard .upload() uses plain fetch with no resume,
// so a dropped connection mid-upload (common on mobile/Safari) means the
// whole upload dies and the user sees no feedback. Photos (2-3MB) complete
// fast enough to dodge this; videos (10-100MB) consistently don't.
//
// tus-js-client chunks the file (6MB per Supabase's documented limit),
// uploads each chunk independently, and resumes from the last successful
// chunk if the connection drops. Network blips become "pauses" instead of
// "failures."

import * as tus from 'tus-js-client'
import { supabase } from '../supabase'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const CHUNK_SIZE = 6 * 1024 * 1024 // 6MB — Supabase's documented chunk size

export type ResumableResult =
  | { publicUrl: string }
  | { error: string }

export async function uploadVideoResumable(
  bucket: string,
  fileName: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ResumableResult> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { error: 'Not authenticated' }

  return new Promise<ResumableResult>((resolve) => {
    const upload = new tus.Upload(file, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      headers: {
        authorization: `Bearer ${session.access_token}`,
        'x-upsert': 'true',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: bucket,
        objectName: fileName,
        contentType: file.type || 'video/mp4',
        cacheControl: '3600',
      },
      chunkSize: CHUNK_SIZE,
      onError: (err: Error) => {
        console.error('[tus upload] failed:', err.message)
        resolve({ error: err.message })
      },
      onProgress: (bytesSent: number, bytesTotal: number) => {
        if (!onProgress) return
        const pct = Math.round((bytesSent / bytesTotal) * 100)
        onProgress(pct)
      },
      onSuccess: () => {
        const { data } = supabase.storage.from(bucket).getPublicUrl(fileName)
        resolve({ publicUrl: data.publicUrl })
      },
    })

    upload.findPreviousUploads().then((previousUploads) => {
      if (previousUploads.length > 0) {
        upload.resumeFromPreviousUpload(previousUploads[0])
      }
      upload.start()
    })
  })
}

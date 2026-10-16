const mediaTypeByName: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg'
};

/** True when the renderer runs inside the desktop shell that can stream local media. */
export function canReadLocalMedia(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'opencreator-app:';
}

export function localMediaUrl(path: string): string {
  return `opencreator-app://app/__local-media?path=${encodeURIComponent(path)}`;
}

export function fileNameFromPath(path: string): string {
  const name = path.split(/[\\/]/).filter(part => part.length > 0).pop();
  return name !== undefined && name.length > 0 ? name : 'video.mp4';
}

export function mediaTypeForFileName(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return mediaTypeByName[name.slice(dot + 1).toLowerCase()];
}

/**
 * Reads a video/audio file from the local disk through the desktop shell's
 * `__local-media` route and exposes it as a `File`, so the existing upload
 * pipeline can treat a downloaded drama episode like a hand-picked file.
 */
export async function fileFromLocalPath(path: string): Promise<File> {
  const name = fileNameFromPath(path);
  const response = await fetch(localMediaUrl(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(`local_media_read_failed:${response.status}`);
  const blob = await response.blob();
  const type = mediaTypeForFileName(name) ?? (blob.type.length > 0 ? blob.type : 'application/octet-stream');
  return new File([blob], name, { type, lastModified: Date.now() });
}

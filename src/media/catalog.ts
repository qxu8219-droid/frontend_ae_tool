import type { FrameCatalog } from '../api/generated/frame-catalog.gen';
import { validateFrameCatalog } from '../api/validation';
import { decodeStamp } from './stamp';

export const validateCatalog = validateFrameCatalog;
export function selectSnapshot(catalog: FrameCatalog, samples: ReadonlyArray<ArrayLike<number>>, sessionId: string) {
  if (catalog.session_id !== sessionId) throw new Error('Catalog belongs to a retired session');
  const id = decodeStamp(samples);
  const matches = catalog.snapshots.filter(frame => frame.capture_id === id && frame.session_id === sessionId);
  if (matches.length !== 1) throw new Error('Image ID is absent or ambiguous in this access unit catalog');
  return matches[0];
}

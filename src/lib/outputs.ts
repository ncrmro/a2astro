import type { A2aArtifact } from './a2a-types.ts';
import { isOutputArtifact, readOutfitterTaskMetadata } from './a2a-types.ts';

export interface RecordedOutput {
  name: string;
  type?: string;
  value: Record<string, unknown>;
  href?: string;
  identifier?: string;
  title?: string;
}

export const isHttpUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\//i.test(value);

/** Normalize recorded workflow-output artifacts for display. */
export const recordedOutputs = (artifacts: readonly A2aArtifact[] | undefined): RecordedOutput[] =>
  (artifacts ?? []).flatMap((artifact) => {
    if (!isOutputArtifact(artifact)) return [];

    const metadata = readOutfitterTaskMetadata(artifact.metadata)!;
    const value = typeof metadata.value === 'object' && metadata.value !== null && !Array.isArray(metadata.value)
      ? metadata.value
      : {};
    const href = isHttpUrl(value.html_url) ? value.html_url : undefined;
    const identifier = typeof value.number === 'number'
      ? `#${value.number}`
      : typeof value.sha === 'string'
        ? value.sha.slice(0, 7)
        : undefined;
    const title = typeof value.title === 'string' ? value.title : undefined;

    return [{
      name: metadata.output!,
      ...(typeof metadata.type === 'string' ? { type: metadata.type } : {}),
      value,
      ...(href ? { href } : {}),
      ...(identifier !== undefined ? { identifier } : {}),
      ...(title !== undefined ? { title } : {}),
    }];
  });

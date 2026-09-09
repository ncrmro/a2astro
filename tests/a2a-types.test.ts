import { describe, expect, it } from 'vitest';

import {
  OUTFITTER_TASK_EXTENSION_URI,
  OUTFITTER_TASK_METADATA_KEY,
  isOutputArtifact,
  readOutfitterTaskMetadata,
  type A2aArtifact,
} from '../src/lib/a2a-types.ts';

const artifact = (over: Partial<A2aArtifact> = {}): A2aArtifact => ({
  artifactId: 'artifact-1',
  parts: [],
  ...over,
});

describe('outfitter task metadata', () => {
  it('reads recorded output metadata', () => {
    const metadata = {
      [OUTFITTER_TASK_METADATA_KEY]: {
        output: 'pull_request',
        type: 'pull-request',
        value: { number: 42, html_url: 'https://example.test/pull/42' },
      },
    };
    expect(readOutfitterTaskMetadata(metadata)).toEqual(metadata[OUTFITTER_TASK_METADATA_KEY]);
    expect(isOutputArtifact(artifact({ metadata }))).toBe(true);
  });

  it('rejects absent and malformed metadata payloads', () => {
    expect(readOutfitterTaskMetadata(undefined)).toBeUndefined();
    expect(readOutfitterTaskMetadata({})).toBeUndefined();
    expect(readOutfitterTaskMetadata({ [OUTFITTER_TASK_METADATA_KEY]: 'nope' })).toBeUndefined();
    expect(readOutfitterTaskMetadata({ [OUTFITTER_TASK_METADATA_KEY]: [] })).toBeUndefined();
  });

  it('requires a non-empty string output name', () => {
    expect(
      isOutputArtifact(
        artifact({
          extensions: [OUTFITTER_TASK_EXTENSION_URI],
          metadata: { [OUTFITTER_TASK_METADATA_KEY]: { output: null } },
        }),
      ),
    ).toBe(false);
    expect(isOutputArtifact(artifact({ metadata: { [OUTFITTER_TASK_METADATA_KEY]: { output: 7 } } }))).toBe(false);
    expect(isOutputArtifact(artifact({ metadata: { [OUTFITTER_TASK_METADATA_KEY]: { output: '' } } }))).toBe(false);
  });

  it('does not treat ordinary artifacts as outputs', () => {
    expect(isOutputArtifact(artifact({ parts: [{ text: 'reply' }] }))).toBe(false);
  });
});

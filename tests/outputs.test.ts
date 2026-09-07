import { describe, expect, it } from 'vitest';

import {
  OUTFITTER_TASK_METADATA_KEY,
  type A2aArtifact,
} from '../src/lib/a2a-types.ts';
import { recordedOutputs } from '../src/lib/outputs.ts';

const artifact = (metadata: unknown, artifactId = 'artifact'): A2aArtifact => ({
  artifactId,
  parts: [{ data: {} }],
  metadata: { [OUTFITTER_TASK_METADATA_KEY]: metadata },
});

describe('recordedOutputs', () => {
  it('derives forge links, numbered identifiers, types, and titles', () => {
    expect(recordedOutputs([
      artifact({
        output: 'issue',
        type: 'github-issue',
        value: { html_url: 'https://github.com/example/repo/issues/42', number: 42, sha: 'abcdefghi', title: 'Fix the thing' },
      }),
    ])).toEqual([{
      name: 'issue',
      type: 'github-issue',
      value: { html_url: 'https://github.com/example/repo/issues/42', number: 42, sha: 'abcdefghi', title: 'Fix the thing' },
      href: 'https://github.com/example/repo/issues/42',
      identifier: '#42',
      title: 'Fix the thing',
    }]);
  });

  it('uses the first seven sha characters when no numeric identifier exists', () => {
    expect(recordedOutputs([
      artifact({ output: 'commit', value: { sha: '0123456789abcdef' } }),
    ])[0]?.identifier).toBe('0123456');
  });

  it('only exposes http(s) strings as links', () => {
    const outputs = recordedOutputs([
      artifact({ output: 'http', value: { html_url: 'http://example.com/1' } }, 'http'),
      artifact({ output: 'https', value: { html_url: 'HTTPS://example.com/2' } }, 'https'),
      artifact({ output: 'ftp', value: { html_url: 'ftp://example.com/3' } }, 'ftp'),
      artifact({ output: 'script', value: { html_url: 'javascript:alert(1)' } }, 'script'),
      artifact({ output: 'object', value: { html_url: { href: 'https://example.com/4' } } }, 'object'),
    ]);

    expect(outputs.map((output) => output.href)).toEqual([
      'http://example.com/1',
      'HTTPS://example.com/2',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('normalizes missing or malformed value fields', () => {
    expect(recordedOutputs([
      artifact({ output: 'missing' }, 'missing'),
      artifact({ output: 'array', value: [] }, 'array'),
      artifact({ output: 'wrong-types', type: 7, value: { number: '4', sha: 9, title: false } }, 'wrong-types'),
    ])).toEqual([
      { name: 'missing', value: {} },
      { name: 'array', value: {} },
      { name: 'wrong-types', value: { number: '4', sha: 9, title: false } },
    ]);
  });

  it('ignores non-output artifacts and malformed metadata', () => {
    expect(recordedOutputs([
      { artifactId: 'plain', parts: [{ text: 'reply' }] },
      artifact(null, 'null'),
      artifact([], 'array'),
      artifact('invalid', 'string'),
      artifact({ output: '' }, 'empty-output'),
      artifact({ output: 12 }, 'numeric-output'),
    ])).toEqual([]);
    expect(recordedOutputs(undefined)).toEqual([]);
  });
});

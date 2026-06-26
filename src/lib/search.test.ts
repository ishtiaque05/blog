import { describe, it, expect } from 'vitest';
import { parseQuery, hasErrors } from './search';

describe('parseQuery', () => {
  it('returns no groups for an empty string', () => {
    expect(parseQuery('')).toEqual([]);
    expect(parseQuery('   ')).toEqual([]);
  });

  it('parses bare words as lowercased text terms, AND-grouped', () => {
    expect(parseQuery('Kernel Debug')).toEqual([
      [
        { kind: 'text', value: 'kernel' },
        { kind: 'text', value: 'debug' },
      ],
    ]);
  });

  it('parses tag: as a lowercased tag term', () => {
    expect(parseQuery('tag:Linux')).toEqual([[{ kind: 'tag', value: 'linux' }]]);
  });

  it('parses after: and before: with valid dates', () => {
    expect(parseQuery('after:2026-01-01 before:2026-12-31')).toEqual([
      [
        { kind: 'after', date: '2026-01-01' },
        { kind: 'before', date: '2026-12-31' },
      ],
    ]);
  });

  it('marks malformed dates as error terms preserving the raw token', () => {
    expect(parseQuery('after:nope')).toEqual([[{ kind: 'error', token: 'after:nope' }]]);
  });

  it('parses quoted phrases (lowercased, quotes stripped)', () => {
    expect(parseQuery('"Spatial Streams"')).toEqual([
      [{ kind: 'phrase', value: 'spatial streams' }],
    ]);
  });

  it('splits on OR (any case) into separate AND-groups', () => {
    expect(parseQuery('tag:linux tag:wifi OR tag:bluetooth')).toEqual([
      [
        { kind: 'tag', value: 'linux' },
        { kind: 'tag', value: 'wifi' },
      ],
      [{ kind: 'tag', value: 'bluetooth' }],
    ]);
  });

  it('drops empty groups from leading/trailing/doubled OR', () => {
    expect(parseQuery('OR tag:linux OR OR tag:wifi OR')).toEqual([
      [{ kind: 'tag', value: 'linux' }],
      [{ kind: 'tag', value: 'wifi' }],
    ]);
  });

  it('hasErrors collects raw tokens of all error terms', () => {
    expect(hasErrors(parseQuery('after:bad OR before:also-bad'))).toEqual([
      'after:bad',
      'before:also-bad',
    ]);
    expect(hasErrors(parseQuery('tag:linux'))).toEqual([]);
  });
});

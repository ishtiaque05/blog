import { describe, it, expect } from 'vitest';
import { parseQuery, hasErrors } from './search';
import { matchPost, type IndexEntry } from './search';

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

const post: IndexEntry = {
  id: 'p',
  url: '/blog/posts/p/',
  title: 'WiFi kernel debugging',
  description: 'smbios woes',
  tags: ['linux', 'wifi'],
  date: '2026-06-25',
  text: 'wifi kernel debugging smbios woes linux wifi',
};

describe('matchPost', () => {
  it('matches everything when the query is empty', () => {
    expect(matchPost(post, parseQuery(''))).toBe(true);
  });

  it('matches a tag case-insensitively', () => {
    expect(matchPost(post, parseQuery('tag:LINUX'))).toBe(true);
    expect(matchPost(post, parseQuery('tag:bluetooth'))).toBe(false);
  });

  it('ANDs terms within a group', () => {
    expect(matchPost(post, parseQuery('tag:linux kernel'))).toBe(true);
    expect(matchPost(post, parseQuery('tag:linux missing'))).toBe(false);
  });

  it('ORs across groups', () => {
    expect(matchPost(post, parseQuery('tag:bluetooth OR tag:wifi'))).toBe(true);
    expect(matchPost(post, parseQuery('tag:bluetooth OR tag:android'))).toBe(false);
  });

  it('matches free text against the body haystack', () => {
    expect(matchPost(post, parseQuery('smbios'))).toBe(true);
  });

  it('applies after/before inclusively on the boundary', () => {
    expect(matchPost(post, parseQuery('after:2026-06-25'))).toBe(true);
    expect(matchPost(post, parseQuery('after:2026-06-26'))).toBe(false);
    expect(matchPost(post, parseQuery('before:2026-06-25'))).toBe(true);
    expect(matchPost(post, parseQuery('before:2026-06-24'))).toBe(false);
  });

  it('never matches an error term', () => {
    expect(matchPost(post, parseQuery('after:bad'))).toBe(false);
  });

  it('honors AND-tighter-than-OR precedence', () => {
    // (linux AND missing) OR bluetooth  -> both groups fail
    expect(matchPost(post, parseQuery('tag:linux missing OR tag:bluetooth'))).toBe(false);
    // (linux AND kernel) OR bluetooth -> first group matches
    expect(matchPost(post, parseQuery('tag:linux kernel OR tag:bluetooth'))).toBe(true);
  });
});

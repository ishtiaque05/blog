export interface IndexEntry {
  id: string;
  url: string;
  title: string;
  description: string;
  tags: string[];
  date: string; // YYYY-MM-DD
  text: string; // lowercased haystack: title + description + tags + body
}

export type Term =
  | { kind: 'tag'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'phrase'; value: string }
  | { kind: 'after'; date: string }
  | { kind: 'before'; date: string }
  | { kind: 'error'; token: string };

export type Group = Term[];
export type Query = Group[];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseQuery(input: string): Query {
  const tokens = input.match(/"[^"]*"|\S+/g) ?? [];
  const groups: Group[] = [];
  let current: Group = [];
  for (const token of tokens) {
    if (token.toUpperCase() === 'OR') {
      if (current.length) groups.push(current);
      current = [];
      continue;
    }
    current.push(parseToken(token));
  }
  if (current.length) groups.push(current);
  return groups;
}

function parseToken(token: string): Term {
  const lower = token.toLowerCase();
  if (lower.startsWith('tag:')) {
    return { kind: 'tag', value: lower.slice(4) };
  }
  if (lower.startsWith('after:')) {
    const date = token.slice(6);
    return DATE_RE.test(date) ? { kind: 'after', date } : { kind: 'error', token };
  }
  if (lower.startsWith('before:')) {
    const date = token.slice(7);
    return DATE_RE.test(date) ? { kind: 'before', date } : { kind: 'error', token };
  }
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return { kind: 'phrase', value: token.slice(1, -1).toLowerCase() };
  }
  return { kind: 'text', value: lower };
}

export function hasErrors(query: Query): string[] {
  const bad: string[] = [];
  for (const group of query) {
    for (const term of group) {
      if (term.kind === 'error') bad.push(term.token);
    }
  }
  return bad;
}

export function matchPost(entry: IndexEntry, query: Query): boolean {
  if (query.length === 0) return true;
  return query.some((group) => group.every((term) => matchTerm(entry, term)));
}

function matchTerm(entry: IndexEntry, term: Term): boolean {
  switch (term.kind) {
    case 'tag':
      return entry.tags.some((t) => t.toLowerCase() === term.value);
    case 'text':
    case 'phrase':
      return entry.text.includes(term.value);
    case 'after':
      return entry.date >= term.date;
    case 'before':
      return entry.date <= term.date;
    case 'error':
      return false;
  }
}

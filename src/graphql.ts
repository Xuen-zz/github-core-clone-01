// GraphQL v4 over the shared Store: a small real executor for the subset GitHub's
// API (and the suite) uses — viewer, repository, issue, pullRequest, __type, node(id:)
// and the five mutations. No schema stitching, no codegen: a hand-written tokenizer,
// parser and resolver table. Mutations write through the same Store primitives the
// REST routes use, so a GraphQL write is visible over REST and vice versa.
//
// GraphQL-level failures are HTTP 200 with an `errors` array (never an HTTP error);
// an unknown repository reads `data.repository = null` with no errors; unknown fields
// are reported as `Cannot query field "X" on type "Y".` Global ids are opaque,
// deterministic base64url strings, stable across reads.

import type { ForgeRequest, ForgeResponse } from './transport.ts';
import {
  ApiError,
  diffTrees,
  mergeBase,
  mergePull,
  prMergeable,
  tipTree,
  type Ctx,
} from './rest.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

// ---------------------------------------------------------------- global ids

/** base64url without padding: opaque, deterministic, stable across reads. */
function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function repoGlobalId(owner: string, name: string): string {
  return b64url(`Repository:${owner}/${name}`);
}

function issueGlobalId(owner: string, repo: string, number: number): string {
  return b64url(`Issue:${owner}/${repo}/${number}`);
}

function pullGlobalId(owner: string, repo: string, number: number): string {
  return b64url(`PullRequest:${owner}/${repo}/${number}`);
}

function commentGlobalId(owner: string, repo: string, issueNumber: number, commentId: number): string {
  return b64url(`IssueComment:${owner}/${repo}/${issueNumber}/${commentId}`);
}

interface DecodedId {
  kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';
  owner: string;
  repo: string;
  number: number;
  commentId: number;
}

function decodeGlobalId(id: string): DecodedId | null {
  if (id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const kind = text.slice(0, colon);
  const key = text.slice(colon + 1);
  const parts = key.split('/');
  if (kind === 'Repository' && parts.length === 2) {
    return { kind, owner: parts[0] as string, repo: parts[1] as string, number: 0, commentId: 0 };
  }
  if ((kind === 'Issue' || kind === 'PullRequest') && parts.length === 3) {
    const number = parseInt(parts[2] as string, 10);
    if (!Number.isFinite(number)) return null;
    return { kind, owner: parts[0] as string, repo: parts[1] as string, number, commentId: 0 };
  }
  if (kind === 'IssueComment' && parts.length === 4) {
    const number = parseInt(parts[2] as string, 10);
    const commentId = parseInt(parts[3] as string, 10);
    if (!Number.isFinite(number) || !Number.isFinite(commentId)) return null;
    return { kind, owner: parts[0] as string, repo: parts[1] as string, number, commentId };
  }
  return null;
}

/** Cursor pagination: base64url of `cursor:<issue seq>`. */
function encodeCursor(seq: number): string {
  return b64url(`cursor:${seq}`);
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'Name'; value: string }
  | { kind: 'Int'; value: string }
  | { kind: 'Float'; value: string }
  | { kind: 'String'; value: string }
  | { kind: 'Punct'; value: string };

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '=', '$', '@', '&', '|']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'Punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: 'Punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('Unterminated block string in GraphQL document');
        tokens.push({ kind: 'String', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === '/') out += '/';
          else if (e === '\\') out += '\\';
          else if (e === '"') out += '"';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else if (e !== undefined) out += e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= n) throw new Error('Unterminated string in GraphQL document');
      tokens.push({ kind: 'String', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[_A-Za-z0-9]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'Name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'StringValue'; value: string }
  | { kind: 'IntValue'; value: string }
  | { kind: 'FloatValue'; value: string }
  | { kind: 'BooleanValue'; value: boolean }
  | { kind: 'EnumValue'; value: string }
  | { kind: 'NullValue' }
  | { kind: 'ListValue'; values: ValueNode[] }
  | { kind: 'ObjectValue'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'Field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet?: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition?: string;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VariableDefinition {
  name: string;
  type: string;
  defaultValue?: ValueNode;
}

interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation';
  name?: string;
  variableDefinitions: VariableDefinition[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  isPunct(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'Punct' && t.value === value;
  }

  expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'Punct' || t.value !== value) {
      throw new Error(`Expected '${value}' in GraphQL document but got ${t.kind} ${t.value}`);
    }
  }

  expectName(): string {
    const t = this.next();
    if (t.kind !== 'Name') throw new Error(`Expected a name in GraphQL document but got ${t.kind}`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek() !== undefined) {
      const t = this.peek() as Token;
      if (t.kind === 'Punct' && t.value === '{') {
        doc.operations.push({
          kind: 'Operation',
          operation: 'query',
          variableDefinitions: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | undefined;
        const next = this.peek();
        if (next !== undefined && next.kind === 'Name') name = this.expectName();
        const variableDefinitions = this.isPunct('(') ? this.parseVariableDefinitions() : [];
        this.skipDirectives();
        doc.operations.push({
          kind: 'Operation',
          operation: keyword,
          name,
          variableDefinitions,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('Expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        doc.fragments.set(name, {
          kind: 'Fragment',
          name,
          typeCondition,
          selectionSet: this.parseSelectionSet(),
        });
      } else {
        throw new Error(`Unexpected keyword ${keyword} in GraphQL document`);
      }
    }
    return doc;
  }

  parseVariableDefinitions(): VariableDefinition[] {
    const defs: VariableDefinition[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  parseType(): string {
    if (this.isPunct('[')) {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.isPunct('!')) {
        this.next();
        out += '!';
      }
      return out;
    }
    const name = this.expectName();
    let out = name;
    if (this.isPunct('!')) {
      this.next();
      out += '!';
    }
    return out;
  }

  skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const t = this.peek();
      if (t !== undefined && t.kind === 'Name' && t.value !== 'on') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'FragmentSpread', name };
      }
      let typeCondition: string | undefined;
      if (t !== undefined && t.kind === 'Name' && t.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'Field', alias, name, args, selectionSet };
  }

  parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'Punct' && t.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (t.kind === 'Punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'ListValue', values };
    }
    if (t.kind === 'Punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'ObjectValue', fields };
    }
    if (t.kind === 'String') return { kind: 'StringValue', value: t.value };
    if (t.kind === 'Int') return { kind: 'IntValue', value: t.value };
    if (t.kind === 'Float') return { kind: 'FloatValue', value: t.value };
    if (t.kind === 'Name') {
      if (t.value === 'true') return { kind: 'BooleanValue', value: true };
      if (t.value === 'false') return { kind: 'BooleanValue', value: false };
      if (t.value === 'null') return { kind: 'NullValue' };
      return { kind: 'EnumValue', value: t.value };
    }
    throw new Error(`Unexpected token ${t.kind} ${t.value} as a GraphQL value`);
  }
}

function parseDocument(query: string): DocumentNode {
  return new Parser(tokenize(query)).parseDocument();
}

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'StringValue':
    case 'EnumValue':
    case 'BooleanValue':
      return node.value;
    case 'IntValue':
      return parseInt(node.value, 10);
    case 'FloatValue':
      return parseFloat(node.value);
    case 'NullValue':
      return null;
    case 'ListValue':
      return node.values.map((v) => valueFromAst(v, variables));
    case 'ObjectValue': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueFromAst(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- executor

class GraphQLError extends Error {
  readonly path: (string | number)[];

  constructor(message: string, path: (string | number)[] = []) {
    super(message);
    this.path = path;
  }
}

interface ExecState {
  ctx: Ctx;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
}

type Resolver = (
  parent: Record<string, unknown>,
  args: Record<string, unknown>,
  state: ExecState,
  path: (string | number)[],
) => unknown;

function executeSelectionSet(
  parent: Record<string, unknown>,
  selections: SelectionNode[],
  state: ExecState,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}".`, path);
      if (fragment.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelectionSet(parent, fragment.selectionSet, state, path));
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelectionSet(parent, selection.selectionSet, state, path));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      out[responseKey] = parent.__typename;
      continue;
    }
    const typeName = String(parent.__typename);
    const typeResolvers = RESOLVERS[typeName];
    const resolver = typeResolvers?.[selection.name];
    if (resolver === undefined) {
      throw new GraphQLError(`Cannot query field "${selection.name}" on type "${typeName}".`, fieldPath);
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueFromAst(arg.value, state.variables);
    const value = resolver(parent, args, state, fieldPath);
    out[responseKey] = resolveFieldValue(value, selection.selectionSet, state, fieldPath);
  }
  return out;
}

function resolveFieldValue(
  value: unknown,
  selectionSet: SelectionNode[] | undefined,
  state: ExecState,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  if (selectionSet === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      isRecord(item) && typeof item.__typename === 'string'
        ? executeSelectionSet(item, selectionSet, state, [...path, i])
        : item,
    );
  }
  if (isRecord(value) && typeof value.__typename === 'string') {
    return executeSelectionSet(value, selectionSet, state, path);
  }
  return value;
}

function executeOperation(
  ctx: Ctx,
  doc: DocumentNode,
  variables: Record<string, unknown>,
  operationName: string | undefined,
): Record<string, unknown> {
  const op =
    operationName !== undefined
      ? doc.operations.find((o) => o.name === operationName)
      : doc.operations[0];
  if (op === undefined) {
    return {
      errors: [
        {
          message:
            operationName !== undefined
              ? `Unknown operation named "${operationName}".`
              : 'Must provide an operation name if there are multiple operations.',
        },
      ],
    };
  }
  for (const def of op.variableDefinitions) {
    if (def.type.endsWith('!') && variables[def.name] === undefined) {
      if (def.defaultValue !== undefined) {
        variables[def.name] = valueFromAst(def.defaultValue, variables);
      } else {
        return { data: null, errors: [{ message: `Variable $${def.name} of required type ${def.type} was not provided.` }] };
      }
    }
  }
  const state: ExecState = { ctx, variables, fragments: doc.fragments };
  const root: Record<string, unknown> = { __typename: op.operation === 'mutation' ? 'Mutation' : 'Query' };
  try {
    const data = executeSelectionSet(root, op.selectionSet, state, []);
    return { data };
  } catch (e) {
    if (e instanceof GraphQLError) {
      return { data: null, errors: [{ message: e.message, path: e.path }] };
    }
    if (e instanceof ApiError) {
      return { data: null, errors: [{ message: e.message }] };
    }
    process.stderr.write(`[forge] graphql execute failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Internal error.' }] };
  }
}

// ---------------------------------------------------------------- object wrappers

function userObj(login: string): Record<string, unknown> {
  const isViewer = login === VIEWER_LOGIN;
  return {
    __typename: 'User',
    login,
    id: isViewer ? VIEWER_ID : 1002,
    name: isViewer ? VIEWER_NAME : login,
    email: isViewer ? VIEWER_EMAIL : `${login}@example.invalid`,
  };
}

function repoObj(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __typename: 'PullRequest', repo, pull };
}

function commentObj(
  repo: Repo,
  issue: Issue,
  comment: { id: number; body: string; seq: number },
): Record<string, unknown> {
  return { __typename: 'IssueComment', repo, issue, comment };
}

// ---------------------------------------------------------------- connections

function issueConnection(state: ExecState, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : [];
  if (states.length > 0) {
    list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  let start = 0;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (after !== null) {
    const idx = list.findIndex((i) => i.seq === after);
    if (idx >= 0) start = idx + 1;
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : 30;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.seq) : null;
  return {
    __typename: 'IssueConnection',
    items: page.map((i) => issueObj(repo, i)),
    hasNextPage,
    endCursor,
    totalCount: list.length,
  };
}

function pullConnection(state: ExecState, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  // GitHub's pullRequests defaults to open pull requests.
  const list = [...repo.pulls]
    .filter((p) => p.state === 'open')
    .sort((a, b) => b.seq - a.seq);
  let start = 0;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (after !== null) {
    const idx = list.findIndex((p) => p.seq === after);
    if (idx >= 0) start = idx + 1;
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : 30;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.seq) : null;
  return {
    __typename: 'PullRequestConnection',
    items: page.map((p) => pullObj(repo, p)),
    hasNextPage,
    endCursor,
    totalCount: list.length,
  };
}

// ---------------------------------------------------------------- introspection schema

const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'files', 'createdAt', 'updatedAt', 'author'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'], enumValues: [] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author'], enumValues: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

function typeObj(name: string): Record<string, unknown> | null {
  const info = TYPE_INFO[name];
  if (info === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: info.kind,
    fields: info.fields.map((f) => ({ __typename: '__Field', name: f })),
    enumValues: info.enumValues.map((v) => ({ __typename: '__EnumValue', name: v })),
  };
}

function repoFromGlobalId(state: ExecState, id: string): Repo | null {
  const dec = decodeGlobalId(id);
  if (dec === null || dec.kind !== 'Repository') return null;
  return state.ctx.store.getRepo(dec.owner, dec.repo) ?? null;
}

// ---------------------------------------------------------------- resolvers

function repoOf(parent: Record<string, unknown>): Repo {
  return parent.repo as Repo;
}

function issueOf(parent: Record<string, unknown>): Issue {
  return parent.issue as Issue;
}

function pullOf(parent: Record<string, unknown>): Pull {
  return parent.pull as Pull;
}

function commentOf(parent: Record<string, unknown>): { id: number; body: string; seq: number } {
  return parent.comment as { id: number; body: string; seq: number };
}

function mutationCreateIssue(
  _parent: Record<string, unknown>,
  args: Record<string, unknown>,
  state: ExecState,
): Record<string, unknown> {
  const input = isRecord(args.input) ? args.input : {};
  const repo = repoFromGlobalId(state, asStr(input.repositoryId));
  if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the id provided.');
  const title = asStr(input.title);
  if (title === '') throw new GraphQLError('A title is required to create an issue.');
  const sec = state.ctx.store.clock.tick();
  const issue: Issue = {
    number: repo.nextIssue++,
    title,
    body: asStr(input.body),
    state: 'open',
    labels: [],
    comments: [],
    seq: repo.nextIssue,
    createdSec: sec,
    updatedSec: sec,
  };
  repo.issues.push(issue);
  return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
}

function mutationCloseIssue(
  _parent: Record<string, unknown>,
  args: Record<string, unknown>,
  state: ExecState,
): Record<string, unknown> {
  const input = isRecord(args.input) ? args.input : {};
  const dec = decodeGlobalId(asStr(input.issueId));
  if (dec === null || dec.kind !== 'Issue') {
    throw new GraphQLError('Could not resolve to an Issue with the id provided.');
  }
  const repo = state.ctx.store.getRepo(dec.owner, dec.repo);
  const issue = repo?.issues.find((i) => i.number === dec.number);
  if (repo === undefined || issue === undefined) {
    throw new GraphQLError('Could not resolve to an Issue with the id provided.');
  }
  issue.state = 'closed';
  issue.updatedSec = state.ctx.store.clock.tick();
  return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
}

function mutationCreatePullRequest(
  _parent: Record<string, unknown>,
  args: Record<string, unknown>,
  state: ExecState,
): Record<string, unknown> {
  const input = isRecord(args.input) ? args.input : {};
  const repo = repoFromGlobalId(state, asStr(input.repositoryId));
  if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the id provided.');
  const headRef = asStr(input.headRefName);
  const baseRef = asStr(input.baseRefName);
  const title = asStr(input.title);
  if (headRef === '' || title === '') throw new GraphQLError('headRefName and title are required.');
  const headSha = state.ctx.store.resolveRef(repo, headRef);
  const baseSha = state.ctx.store.resolveRef(repo, baseRef);
  if (headSha === '' || baseSha === '') throw new GraphQLError('head or base branch does not exist.');
  const sec = state.ctx.store.clock.tick();
  const pull: Pull = {
    number: repo.nextPull++,
    title,
    body: asStr(input.body),
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    seq: repo.nextPull,
    createdSec: sec,
    updatedSec: sec,
  };
  repo.pulls.push(pull);
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
}

function mutationMergePullRequest(
  _parent: Record<string, unknown>,
  args: Record<string, unknown>,
  state: ExecState,
): Record<string, unknown> {
  const input = isRecord(args.input) ? args.input : {};
  const dec = decodeGlobalId(asStr(input.pullRequestId));
  if (dec === null || dec.kind !== 'PullRequest') {
    throw new GraphQLError('Could not resolve to a PullRequest with the id provided.');
  }
  const repo = state.ctx.store.getRepo(dec.owner, dec.repo);
  const pull = repo?.pulls.find((p) => p.number === dec.number);
  if (repo === undefined || pull === undefined) {
    throw new GraphQLError('Could not resolve to a PullRequest with the id provided.');
  }
  // Same squash merge the REST route runs (throws ApiError on conflict/closed).
  mergePull(state.ctx, repo, pull);
  return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
}

function mutationAddComment(
  _parent: Record<string, unknown>,
  args: Record<string, unknown>,
  state: ExecState,
): Record<string, unknown> {
  const input = isRecord(args.input) ? args.input : {};
  const dec = decodeGlobalId(asStr(input.subjectId));
  if (dec === null || dec.kind !== 'Issue') {
    throw new GraphQLError('Could not resolve to an Issue with the id provided.');
  }
  const repo = state.ctx.store.getRepo(dec.owner, dec.repo);
  const issue = repo?.issues.find((i) => i.number === dec.number);
  if (repo === undefined || issue === undefined) {
    throw new GraphQLError('Could not resolve to an Issue with the id provided.');
  }
  const body = asStr(input.body);
  if (body === '') throw new GraphQLError('A body is required to add a comment.');
  const id = repo.nextComment++;
  const comment = { id, body, seq: id };
  issue.comments.push(comment);
  return {
    __typename: 'AddCommentPayload',
    commentEdge: { __typename: 'IssueCommentEdge', node: commentObj(repo, issue, comment) },
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(VIEWER_LOGIN),
    repository: (_parent, args, state) => {
      const owner = asStr(args.owner);
      const name = asStr(args.name);
      if (owner !== VIEWER_LOGIN) return null;
      const repo = state.ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoObj(repo);
    },
    node: (_parent, args, state) => {
      const dec = decodeGlobalId(asStr(args.id));
      if (dec === null) return null;
      const repo = state.ctx.store.getRepo(dec.owner, dec.repo);
      if (repo === undefined) return null;
      if (dec.kind === 'Repository') return repoObj(repo);
      if (dec.kind === 'Issue') {
        const issue = repo.issues.find((i) => i.number === dec.number);
        return issue === undefined ? null : issueObj(repo, issue);
      }
      if (dec.kind === 'PullRequest') {
        const pull = repo.pulls.find((p) => p.number === dec.number);
        return pull === undefined ? null : pullObj(repo, pull);
      }
      if (dec.kind === 'IssueComment') {
        const issue = repo.issues.find((i) => i.number === dec.number);
        if (issue === undefined) return null;
        const comment = issue.comments.find((c) => c.id === dec.commentId);
        return comment === undefined ? null : commentObj(repo, issue, comment);
      }
      return null;
    },
    __type: (_parent, args) => typeObj(asStr(args.name)),
  },
  User: {
    login: (p) => p.login,
    id: (p) => p.id,
    name: (p) => p.name,
    email: (p) => p.email,
  },
  Repository: {
    id: (p) => {
      const r = repoOf(p);
      return repoGlobalId(r.owner, r.name);
    },
    databaseId: (p) => repoOf(p).seq + 1,
    name: (p) => repoOf(p).name,
    nameWithOwner: (p) => {
      const r = repoOf(p);
      return `${r.owner}/${r.name}`;
    },
    owner: (p) => userObj(repoOf(p).owner),
    defaultBranchRef: (p, _args, state) => {
      const r = repoOf(p);
      const tip = state.ctx.store.refTip(r, `refs/heads/${r.defaultBranch}`);
      return tip === '' ? null : { __typename: 'Ref', name: r.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (p) => repoOf(p).description,
    url: (p, _args, state) => {
      const r = repoOf(p);
      return `${state.ctx.baseUrl}/${r.owner}/${r.name}`;
    },
    createdAt: (p, _args, state) => state.ctx.store.clock.iso(1_735_689_600 + repoOf(p).seq),
    updatedAt: (p, _args, state) => state.ctx.store.clock.iso(1_735_689_600 + repoOf(p).seq),
    issue: (p, args) => {
      const r = repoOf(p);
      if (typeof args.number !== 'number') return null;
      const issue = r.issues.find((i) => i.number === args.number);
      return issue === undefined ? null : issueObj(r, issue);
    },
    issues: (p, args, state) => issueConnection(state, repoOf(p), args),
    pullRequest: (p, args) => {
      const r = repoOf(p);
      if (typeof args.number !== 'number') return null;
      const pull = r.pulls.find((x) => x.number === args.number);
      return pull === undefined ? null : pullObj(r, pull);
    },
    pullRequests: (p, args, state) => pullConnection(state, repoOf(p), args),
  },
  Ref: {
    name: (p) => p.name,
    prefix: () => 'refs/heads/',
  },
  Issue: {
    id: (p) => {
      const r = repoOf(p);
      return issueGlobalId(r.owner, r.name, issueOf(p).number);
    },
    number: (p) => issueOf(p).number,
    title: (p) => issueOf(p).title,
    body: (p) => issueOf(p).body,
    state: (p) => (issueOf(p).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (p, _args, state) => state.ctx.store.clock.iso(issueOf(p).createdSec),
    updatedAt: (p, _args, state) => state.ctx.store.clock.iso(issueOf(p).updatedSec),
    author: () => userObj(VIEWER_LOGIN),
    repository: (p) => repoObj(repoOf(p)),
    url: (p, _args, state) => {
      const r = repoOf(p);
      return `${state.ctx.baseUrl}/${r.owner}/${r.name}/issues/${issueOf(p).number}`;
    },
    labels: (p) => ({
      __typename: 'LabelConnection',
      items: issueOf(p).labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color })),
    }),
    comments: (p) => {
      const r = repoOf(p);
      const i = issueOf(p);
      return {
        __typename: 'IssueCommentConnection',
        items: i.comments.map((c) => commentObj(r, i, c)),
        totalCount: i.comments.length,
      };
    },
  },
  LabelConnection: {
    nodes: (p) => p.items,
    totalCount: (p) => (p.items as unknown[]).length,
  },
  Label: {
    name: (p) => p.name,
    color: (p) => p.color,
  },
  IssueCommentConnection: {
    nodes: (p) => p.items,
    totalCount: (p) => p.totalCount,
  },
  PullRequest: {
    id: (p) => {
      const r = repoOf(p);
      return pullGlobalId(r.owner, r.name, pullOf(p).number);
    },
    number: (p) => pullOf(p).number,
    title: (p) => pullOf(p).title,
    body: (p) => pullOf(p).body,
    state: (p) => {
      const x = pullOf(p);
      return x.merged ? 'MERGED' : x.state === 'closed' ? 'CLOSED' : 'OPEN';
    },
    headRefName: (p) => pullOf(p).headRef,
    baseRefName: (p) => pullOf(p).baseRef,
    mergeable: (p, _args, state) => prMergeable(state.ctx, repoOf(p), pullOf(p)),
    merged: (p) => pullOf(p).merged,
    mergedAt: (p) => (pullOf(p).merged ? pullOf(p).mergedAt : null),
    createdAt: (p, _args, state) => state.ctx.store.clock.iso(pullOf(p).createdSec),
    updatedAt: (p, _args, state) => state.ctx.store.clock.iso(pullOf(p).updatedSec),
    author: () => userObj(VIEWER_LOGIN),
    files: (p, args, state) => {
      const r = repoOf(p);
      const x = pullOf(p);
      const base = mergeBase(state.ctx, r, x.headSha, x.baseSha);
      const baseTree = base === '' ? null : tipTree(state.ctx, r, base);
      const headTree = tipTree(state.ctx, r, x.headSha);
      const files = diffTrees(state.ctx, r, baseTree, headTree);
      const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : 10;
      return {
        __typename: 'FileConnection',
        files: files.slice(0, first).map((f) => ({
          __typename: 'File',
          path: f.filename,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
      };
    },
  },
  FileConnection: {
    nodes: (p) => p.files,
    totalCount: (p) => (p.files as unknown[]).length,
  },
  File: {
    path: (p) => p.path,
    additions: (p) => p.additions,
    deletions: (p) => p.deletions,
    changes: (p) => p.changes,
  },
  IssueConnection: {
    nodes: (p) => p.items,
    pageInfo: (p) => ({ __typename: 'PageInfo', hasNextPage: p.hasNextPage, endCursor: p.endCursor }),
    totalCount: (p) => p.totalCount,
  },
  PullRequestConnection: {
    nodes: (p) => p.items,
    pageInfo: (p) => ({ __typename: 'PageInfo', hasNextPage: p.hasNextPage, endCursor: p.endCursor }),
    totalCount: (p) => p.totalCount,
  },
  PageInfo: {
    hasNextPage: (p) => p.hasNextPage,
    hasPreviousPage: () => false,
    startCursor: () => null,
    endCursor: (p) => p.endCursor,
  },
  IssueComment: {
    id: (p) => {
      const r = repoOf(p);
      return commentGlobalId(r.owner, r.name, issueOf(p).number, commentOf(p).id);
    },
    body: (p) => commentOf(p).body,
    createdAt: (p, _args, state) => state.ctx.store.clock.iso(issueOf(p).createdSec),
    author: () => userObj(VIEWER_LOGIN),
  },
  __Type: {
    name: (p) => p.name,
    kind: (p) => p.kind,
    description: () => null,
    fields: (p) => p.fields,
    enumValues: (p) => p.enumValues,
  },
  __Field: {
    name: (p) => p.name,
    description: () => null,
  },
  __EnumValue: {
    name: (p) => p.name,
    description: () => null,
  },
  Mutation: {
    createIssue: mutationCreateIssue,
    closeIssue: mutationCloseIssue,
    createPullRequest: mutationCreatePullRequest,
    mergePullRequest: mutationMergePullRequest,
    addComment: mutationAddComment,
  },
  CreateIssuePayload: {
    issue: (p) => p.issue,
  },
  CloseIssuePayload: {
    issue: (p) => p.issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (p) => p.pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (p) => p.pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (p) => p.commentEdge,
  },
  IssueCommentEdge: {
    node: (p) => p.node,
  },
};

// ---------------------------------------------------------------- HTTP handler

function executeRequest(ctx: Ctx, body: unknown): Record<string, unknown> {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { errors: [{ message: 'The request body must be a JSON object with a string "query".' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  let doc: DocumentNode;
  try {
    doc = parseDocument(body.query);
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : 'GraphQL syntax error.' }] };
  }
  try {
    return executeOperation(ctx, doc, variables, operationName);
  } catch (e) {
    process.stderr.write(
      `[forge] graphql execute failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Internal error.' }] };
  }
}

export async function handleGraphql(
  ctx: Ctx,
  req: ForgeRequest,
  res: ForgeResponse,
  _url: { pathname: string; searchParams: URLSearchParams },
  body: unknown,
  baseHeaders: Record<string, string>,
): Promise<boolean> {
  if (req.url === undefined) return false;
  const path = new URL(req.url, 'http://entry').pathname;
  if (path !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') return false;
  const send = (status: number, payload: unknown): void => {
    const text = `${JSON.stringify(payload)}\n`;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      ...baseHeaders,
    });
    res.end(text);
  };
  if (body === null || body === undefined) {
    send(200, { errors: [{ message: 'A GraphQL operation body is required.' }] });
    return true;
  }
  if (Array.isArray(body)) {
    send(
      200,
      body.map((item) => executeRequest(ctx, item)),
    );
    return true;
  }
  send(200, executeRequest(ctx, body));
  return true;
}

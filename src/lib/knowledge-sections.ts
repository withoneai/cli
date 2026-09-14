/**
 * Header-based sectioning for action knowledge markdown.
 *
 * The backend returns one markdown document per action. Half of them are under
 * ~8k chars, but the tail is long (p90 ~17k, max ~370k) and the bulk of every
 * large doc sits in three sections — `Success Response`, `Response Fields`, and
 * `Optional Request Body Fields`. Agents pay per token, so `actions knowledge`
 * hands back a *digest*: the sections needed to build a correct request in
 * full, plus a table of contents for everything else. The agent asks for the
 * rest by name (`--section "Response Fields"`) and it is served from the disk
 * cache with no network round trip.
 *
 * Everything in this module is pure: string in, structure out. No I/O.
 */

export type SectionTier = 'essential' | 'deferred';
export type SectionInclusion = true | false | 'partial';

export interface KnowledgeSection {
  /** Stable slug derived from the heading, unique within the document. */
  id: string;
  /** Heading text without the leading `#`s. */
  heading: string;
  /** Markdown heading level (1-6). */
  level: number;
  /** The section's own text: the heading line plus its body, excluding children. */
  text: string;
  /** Char count of the section including all nested children. */
  chars: number;
  tier: SectionTier;
  children: KnowledgeSection[];
}

export interface ParsedKnowledge {
  /** The first H1, or '' when the document has none. */
  title: string;
  /** Text before the first heading (rare; usually empty). */
  preface: string;
  /** Top-level sections in document order. */
  sections: KnowledgeSection[];
  /** Total chars of the source document. */
  chars: number;
}

export interface SectionSummary {
  id: string;
  heading: string;
  level: number;
  chars: number;
  included: SectionInclusion;
}

export interface KnowledgeDigest {
  /** Markdown to hand the agent. */
  markdown: string;
  /** True when `markdown` is not the whole document. */
  truncated: boolean;
  /** Every section in document order, flagged with what the digest included. */
  sections: SectionSummary[];
  /** Number of top-most sections not fully included (children of an omitted parent are implied). */
  omitted: number;
  /** Chars of source material not in the digest. */
  omittedChars: number;
}

export interface DigestOptions {
  /** Documents at or below this size are returned whole. */
  wholeDocThreshold?: number;
  /** Target size for the digest markdown (essential sections may exceed it). */
  budget?: number;
  /** A single essential section larger than this is cut and marked partial. */
  sectionCap?: number;
}

export const DEFAULT_WHOLE_DOC_THRESHOLD = 8_000;
export const DEFAULT_DIGEST_BUDGET = 8_000;
export const DEFAULT_SECTION_CAP = 6_000;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^\s*(```|~~~)/;

interface RawBlock {
  level: number;
  heading: string;
  lines: string[];
}

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

/**
 * Split markdown into a section tree keyed by ATX headings. Headings inside
 * fenced code blocks are ignored. Setext (underlined) headings are not
 * recognised — the backend never emits them.
 */
export function parseSections(markdown: string): ParsedKnowledge {
  const lines = markdown.split('\n');
  const prefaceLines: string[] = [];
  const blocks: RawBlock[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const line of lines) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (fence[1] === fenceMarker) {
        inFence = false;
      }
    }
    const m = !inFence ? HEADING_RE.exec(line) : null;
    if (m) {
      blocks.push({ level: m[1].length, heading: m[2].trim(), lines: [line] });
      continue;
    }
    if (blocks.length === 0) prefaceLines.push(line);
    else blocks[blocks.length - 1].lines.push(line);
  }

  const usedIds = new Set<string>();
  const nodes: KnowledgeSection[] = blocks.map((b) => {
    const base = slugify(b.heading);
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return {
      id,
      heading: b.heading,
      level: b.level,
      text: b.lines.join('\n'),
      chars: 0,
      tier: classifyHeading(b.heading),
      children: [],
    };
  });

  // Build the tree by level. The first heading, when it is an H1, is the title;
  // its children are promoted so the document's H2s are the top-level sections.
  const root: KnowledgeSection[] = [];
  const stack: KnowledgeSection[] = [];
  let title = '';
  let titleNode: KnowledgeSection | null = null;

  for (const node of nodes) {
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root.push(node);
    stack.push(node);
  }

  if (root.length && nodes[0].level === 1 && root[0] === nodes[0]) {
    titleNode = root.shift()!;
    title = titleNode.heading;
    root.unshift(...titleNode.children);
    titleNode.children = [];
  }

  // Any text under the title heading itself (before the first H2) becomes preface.
  let preface = prefaceLines.join('\n').trim();
  if (titleNode) {
    const own = titleNode.text.split('\n').slice(1).join('\n').trim();
    if (own) preface = preface ? `${preface}\n\n${own}` : own;
  }

  const measure = (n: KnowledgeSection): number => {
    n.chars = n.text.length + n.children.reduce((sum, c) => sum + measure(c), 0);
    return n.chars;
  };
  root.forEach(measure);

  return { title, preface, sections: root, chars: markdown.length };
}

/** Full markdown for a section including its nested children. */
export function sectionText(section: KnowledgeSection): string {
  const parts = [section.text, ...section.children.map(sectionText)];
  return parts.join('\n').replace(/\n+$/, '');
}

export function flattenSections(sections: KnowledgeSection[]): KnowledgeSection[] {
  const out: KnowledgeSection[] = [];
  const walk = (list: KnowledgeSection[]) => {
    for (const s of list) {
      out.push(s);
      walk(s.children);
    }
  };
  walk(sections);
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Lower-case, strip a trailing parenthetical like "(200 OK)" or "(application/json)". */
export function canonicalHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ESSENTIAL_EXACT = new Set([
  'prerequisites',
  'method',
  'url',
  'endpoint',
  'headers',
  'description',
  'enforcement rules',
  'valid examples',
  'invalid examples',
  'request body',
  'sample request',
  'gotchas',
  'error handling',
  'graphql operation',
  'graphql arguments',
  'request variables',
  'variables',
  'path parameters',
  'query parameters',
  'parameters',
  'arguments',
]);

const ESSENTIAL_PREFIX = ['required '];

/**
 * Essential sections are what an agent needs to build a correct request.
 * Everything else — response shapes, optional fields, worked examples, prose —
 * is deferred and listed in the table of contents.
 */
export function classifyHeading(heading: string): SectionTier {
  const c = canonicalHeading(heading);
  if (ESSENTIAL_EXACT.has(c)) return 'essential';
  if (ESSENTIAL_PREFIX.some((p) => c.startsWith(p))) return 'essential';
  return 'deferred';
}

/** Priority for back-filling deferred sections into spare budget (lower = sooner). */
function deferredPriority(heading: string): number {
  const c = canonicalHeading(heading);
  if (c.startsWith('optional ')) return 0;
  if (c === 'behavior' || c === 'behaviour') return 1;
  if (c === 'notes') return 2;
  if (c === 'example usage' || c.startsWith('example')) return 3;
  if (c === 'response fields') return 5;
  if (c === 'response' || c.startsWith('success response') || c.startsWith('error response')) return 6;
  return 4;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

interface Decision {
  node: KnowledgeSection;
  included: SectionInclusion;
  /** Rendered text for included/partial nodes (own text only; children decided separately). */
  render: string;
}

function truncateText(text: string, cap: number, id: string): string {
  const cut = text.slice(0, cap);
  // Back up to a line boundary so we never split a table row or code fence mid-way.
  const nl = cut.lastIndexOf('\n');
  const head = nl > cap * 0.5 ? cut.slice(0, nl) : cut;
  const remaining = text.length - head.length;
  return `${head}\n\n_[truncated — ${remaining.toLocaleString('en-US')} more chars. Load the full section with --section ${id}]_`;
}

/**
 * Build the digest: essential sections in full (capped), then deferred
 * sections back-filled in priority order while they fit the budget, then a
 * table of contents for what was left out.
 */
export function buildDigest(doc: ParsedKnowledge, opts: DigestOptions = {}): KnowledgeDigest {
  const wholeThreshold = opts.wholeDocThreshold ?? DEFAULT_WHOLE_DOC_THRESHOLD;
  const budget = opts.budget ?? DEFAULT_DIGEST_BUDGET;
  const cap = opts.sectionCap ?? DEFAULT_SECTION_CAP;
  const flat = flattenSections(doc.sections);

  const whole = (): KnowledgeDigest => ({
    markdown: renderWhole(doc),
    truncated: false,
    sections: flat.map((s) => summary(s, true)),
    omitted: 0,
    omittedChars: 0,
  });

  // Nothing to section on, or small enough that a second round trip costs more than it saves.
  if (flat.length === 0 || doc.chars <= wholeThreshold) return whole();

  const decisions = new Map<string, Decision>();
  let used = doc.title ? doc.title.length + 4 : 0;
  used += doc.preface.length;

  // Pass 1: essentials. A deferred child of an essential parent (e.g. Optional
  // fields under a custom action's `Request Body`) stays deferred — unless it is
  // a sub-section (H3+) that itself contains essentials, such as Notion's
  // `Request Body > Option B > Required Request Body Fields`. Then its own text
  // is kept as scaffolding and its children are decided individually. H1/H2
  // deferred nodes (appended schema chunks, companion endpoints) go wholesale.
  const hasEssentialDescendant = (n: KnowledgeSection): boolean =>
    n.children.some((c) => c.tier === 'essential' || hasEssentialDescendant(c));
  const walk = (list: KnowledgeSection[]) => {
    for (const node of list) {
      if (node.tier === 'essential' || (node.level >= 3 && hasEssentialDescendant(node))) {
        const own = node.text;
        if (own.length > cap) {
          const render = truncateText(own, cap, node.id);
          decisions.set(node.id, { node, included: 'partial', render });
          used += render.length;
        } else {
          decisions.set(node.id, { node, included: true, render: own });
          used += own.length;
        }
        walk(node.children);
      } else {
        decisions.set(node.id, { node, included: false, render: '' });
        // Children of a deferred node are deferred wholesale.
        for (const c of flattenSections(node.children)) decisions.set(c.id, { node: c, included: false, render: '' });
      }
    }
  };
  walk(doc.sections);

  // Pass 2: back-fill deferred subtrees whose *parent* is included or top-level,
  // smallest priority first, while they fit whole. Extra H1s (appended schema
  // chunks, companion endpoints) are never back-filled: pulling three random
  // schema types into the digest would mislead more than it helps.
  const candidates = flat
    .filter((s) => decisions.get(s.id)?.included === false)
    .filter((s) => s.level >= 2)
    .filter((s) => {
      const parent = parentOf(doc.sections, s);
      return !parent || decisions.get(parent.id)?.included !== false;
    })
    .sort((a, b) => deferredPriority(a.heading) - deferredPriority(b.heading) || a.chars - b.chars);

  for (const s of candidates) {
    if (used + s.chars > budget) continue;
    for (const n of [s, ...flattenSections(s.children)]) {
      decisions.set(n.id, { node: n, included: true, render: n.text });
    }
    used += s.chars;
  }

  // If everything ended up included, the doc fits — return it whole.
  const allIn = flat.every((s) => decisions.get(s.id)?.included === true);
  if (allIn) return whole();

  // Render in document order.
  const out: string[] = [];
  if (doc.title) out.push(`# ${doc.title}`);
  if (doc.preface) out.push(doc.preface);
  for (const s of flat) {
    const d = decisions.get(s.id)!;
    if (d.included !== false) out.push(d.render.replace(/\n+$/, ''));
  }

  const sections = flat.map((s) => summary(s, decisions.get(s.id)!.included));
  // Chars the agent has not seen: whole omitted subtrees (counted once, at the
  // top-most omitted node) plus the cut tail of every partial section.
  const topOmitted = flat.filter((s) => {
    if (decisions.get(s.id)!.included !== false) return false;
    const parent = parentOf(doc.sections, s);
    return !parent || decisions.get(parent.id)!.included !== false;
  });
  const omittedChars =
    topOmitted.reduce((sum, s) => sum + s.chars, 0) +
    flat
      .filter((s) => decisions.get(s.id)!.included === 'partial')
      .reduce((sum, s) => sum + (s.text.length - decisions.get(s.id)!.render.length), 0);

  return {
    markdown: out.join('\n\n'),
    truncated: true,
    sections,
    omitted: topOmitted.length + flat.filter((s) => decisions.get(s.id)!.included === 'partial').length,
    omittedChars: Math.max(0, omittedChars),
  };
}

function summary(s: KnowledgeSection, included: SectionInclusion): SectionSummary {
  return { id: s.id, heading: s.heading, level: s.level, chars: s.chars, included };
}

function parentOf(roots: KnowledgeSection[], target: KnowledgeSection): KnowledgeSection | null {
  const find = (list: KnowledgeSection[], parent: KnowledgeSection | null): KnowledgeSection | null | undefined => {
    for (const n of list) {
      if (n === target) return parent;
      const r = find(n.children, n);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  return find(roots, null) ?? null;
}

export function renderWhole(doc: ParsedKnowledge): string {
  const out: string[] = [];
  if (doc.title) out.push(`# ${doc.title}`);
  if (doc.preface) out.push(doc.preface);
  for (const s of doc.sections) out.push(sectionText(s));
  return out.join('\n\n');
}

export const DEFAULT_TOC_MAX_ENTRIES = 60;

export interface CollapsedSummary extends SectionSummary {
  /** Number of nested sections hidden under this entry (only when collapsed). */
  children?: number;
}

/**
 * Shrink a table of contents for the JSON envelope. Scraped mega-docs can
 * carry 400+ headings (45 KB of metadata — more than the digest itself), so
 * the list is cut to the shallowest heading depth that fits `max` entries.
 * Hidden descendants are counted on their nearest surviving ancestor; the
 * full list is one `--toc` call away.
 */
export function collapseSections(
  sections: SectionSummary[],
  max: number = DEFAULT_TOC_MAX_ENTRIES
): { sections: CollapsedSummary[]; collapsed: boolean } {
  if (sections.length <= max) return { sections, collapsed: false };

  // The action doc proper is everything before the first extra H1; what
  // follows is appended scrape chunks / companion endpoints. The canonical
  // part keeps its H2s (and H3s when they fit); the appendix collapses to
  // its H1s no matter what — those are the entries nobody needs to see.
  const firstH1 = sections.findIndex((s) => s.level === 1);
  const canonEnd = firstH1 === -1 ? sections.length : firstH1;
  for (const depth of [3, 2]) {
    const keep = (s: SectionSummary, i: number) => (i < canonEnd ? s.level <= depth : s.level <= 1);
    const count = sections.filter(keep).length;
    if (count > max && depth !== 2) continue;
    const out: CollapsedSummary[] = [];
    let owner: CollapsedSummary | null = null;
    sections.forEach((s, i) => {
      if (keep(s, i)) {
        owner = { ...s };
        out.push(owner);
      } else if (owner) {
        owner.children = (owner.children ?? 0) + 1;
      }
    });
    return { sections: out, collapsed: true };
  }
  return { sections, collapsed: false };
}

/**
 * The trailer appended to a digest so an agent that only reads the markdown
 * (and never looks at the JSON envelope) still knows the document continues.
 */
export function renderDigestNotice(
  digest: KnowledgeDigest,
  platform: string,
  actionId: string
): string {
  if (!digest.truncated) return '';
  // List only the top-most omitted sections: in document order the nearest
  // preceding section with a lower level is the parent, and children of an
  // omitted parent are implied by it.
  const topMost = digest.sections.filter((s, idx) => {
    if (s.included === true) return false;
    for (let i = idx - 1; i >= 0; i--) {
      const prev = digest.sections[i];
      if (prev.level < s.level) return prev.included !== false;
    }
    return true;
  });
  // Extra H1s are appended scrape chunks or companion endpoints, not part of
  // the action doc proper — say so, or "Append Block Children" showing up as
  // omitted reads as if the core doc itself were missing.
  const names = topMost.map((s) => {
    if (s.included === 'partial') return `${s.heading} (partial)`;
    if (s.level === 1) return `${s.heading} (appendix)`;
    return s.heading;
  });
  const base = `one --agent actions knowledge ${platform} ${actionId}`;
  // A scraped mega-doc can omit 30+ sections; naming a dozen is enough to
  // orient the agent, the rest are in `sections` / --toc.
  const MAX_NAMES = 12;
  const shown = names.slice(0, MAX_NAMES);
  const rest = names.length - shown.length;
  const nameList = rest > 0 ? `${shown.join(', ')}, and ${rest} more (see --toc)` : shown.join(', ');
  return [
    '---',
    `**This is a digest, not the full document.** ${topMost.length} section${topMost.length === 1 ? '' : 's'} omitted (${digest.omittedChars.toLocaleString('en-US')} chars): ${nameList}.`,
    `Load one or more by name or id:  ${base} --section "${topMost[0]?.heading ?? 'Response'}"`,
    `Load everything:                  ${base} --full`,
  ].join('\n');
}

/**
 * One line for the *top* of a digest, so an agent that reads the beginning of
 * the markdown and stops early still learns the document continues.
 */
export function renderDigestBanner(digest: KnowledgeDigest): string {
  if (!digest.truncated) return '';
  return `> **Digest.** ${digest.omitted} section${digest.omitted === 1 ? '' : 's'} (${digest.omittedChars.toLocaleString('en-US')} chars) omitted — mostly response shapes. The notice at the end names them and shows how to load them; the JSON \`sections\` array marks them included:false.`;
}

// ---------------------------------------------------------------------------
// Section lookup (for --section)
// ---------------------------------------------------------------------------

export interface SectionMatch {
  ok: true;
  sections: KnowledgeSection[];
}
export interface SectionMiss {
  ok: false;
  reason: 'not-found' | 'ambiguous';
  query: string;
  candidates: SectionSummary[];
}

/** Short names agents are likely to type. Each maps to a predicate over the canonical heading. */
const ALIASES: Record<string, (c: string) => boolean> = {
  response: (c) => c === 'response',
  responses: (c) => c === 'response',
  'response fields': (c) => c === 'response fields',
  fields: (c) => c === 'response fields',
  optional: (c) => c.startsWith('optional '),
  required: (c) => c.startsWith('required '),
  examples: (c) => c === 'example usage' || c === 'examples',
  example: (c) => c === 'example usage' || c === 'examples',
  errors: (c) => c.startsWith('error response') || c === 'error handling',
  success: (c) => c.startsWith('success response'),
  body: (c) => c === 'request body' || c.endsWith('request body fields'),
  query: (c) => c.endsWith('query parameters'),
  path: (c) => c.endsWith('path parameters'),
  notes: (c) => c === 'notes',
  behavior: (c) => c === 'behavior' || c === 'behaviour',
  gotchas: (c) => c === 'gotchas',
};

function normalizeQuery(q: string): string {
  return q.trim().replace(/^["'`]+|["'`]+$/g, '').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve one user-supplied name to sections. Match order: exact id, exact
 * heading, alias, slug prefix / heading prefix, substring. Prefix and
 * substring matches must be unique; aliases may return several.
 */
export function findSections(doc: ParsedKnowledge, query: string): SectionMatch | SectionMiss {
  const flat = flattenSections(doc.sections);
  const q = normalizeQuery(query);
  const qSlug = slugify(q);
  const miss = (reason: SectionMiss['reason'], candidates: KnowledgeSection[]): SectionMiss => ({
    ok: false,
    reason,
    query,
    candidates: candidates.map((s) => summary(s, false)),
  });
  if (!q) return miss('not-found', flat);

  // Exact id and exact heading together: a doc with two `## Response`
  // headings (id `response` and `response-2`) should return both, not
  // silently the first.
  const exact = flat.filter(
    (s) => s.id === qSlug || canonicalHeading(s.heading) === q || s.heading.toLowerCase() === q
  );
  if (exact.length) return { ok: true, sections: exact };

  const alias = ALIASES[q];
  if (alias) {
    const hits = flat.filter((s) => alias(canonicalHeading(s.heading)));
    if (hits.length) return { ok: true, sections: dropNested(hits) };
  }

  const byPrefix = flat.filter(
    (s) => s.id.startsWith(qSlug) || canonicalHeading(s.heading).startsWith(q)
  );
  if (byPrefix.length === 1) return { ok: true, sections: byPrefix };
  if (byPrefix.length > 1) {
    // "error response" should match every error response block, not be ambiguous.
    const sameCanon = new Set(byPrefix.map((s) => canonicalHeading(s.heading).replace(/\s*\d.*$/, '')));
    if (sameCanon.size === 1) return { ok: true, sections: dropNested(byPrefix) };
    return miss('ambiguous', byPrefix);
  }

  const bySubstring = flat.filter(
    (s) => s.id.includes(qSlug) || canonicalHeading(s.heading).includes(q)
  );
  if (bySubstring.length === 1) return { ok: true, sections: bySubstring };
  if (bySubstring.length > 1) return miss('ambiguous', bySubstring);

  return miss('not-found', flat);
}

/** If a hit's ancestor is also a hit, drop the descendant — its text is already inside the ancestor. */
function dropNested(hits: KnowledgeSection[]): KnowledgeSection[] {
  const inside = new Set<string>();
  for (const h of hits) for (const c of flattenSections(h.children)) inside.add(c.id);
  return hits.filter((h) => !inside.has(h.id));
}

/**
 * Resolve a comma-separated `--section` value. Every name must resolve; the
 * first failure is returned so the agent can correct it.
 */
export function selectSections(
  doc: ParsedKnowledge,
  names: string[]
): { ok: true; sections: KnowledgeSection[]; markdown: string } | SectionMiss {
  const picked: KnowledgeSection[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const r = findSections(doc, name);
    if (!r.ok) return r;
    for (const s of dropNested(r.sections)) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        picked.push(s);
      }
    }
  }
  // Document order, and drop anything nested inside another pick.
  const order = new Map(flattenSections(doc.sections).map((s, i) => [s.id, i]));
  const final = dropNested(picked).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const parts = [doc.title ? `# ${doc.title}` : '', ...final.map(sectionText)].filter(Boolean);
  return { ok: true, sections: final, markdown: parts.join('\n\n') };
}

/** Split a `--section` flag value (repeatable, comma-separated) into names. */
export function parseSectionFlag(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

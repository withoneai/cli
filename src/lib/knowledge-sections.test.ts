import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSections,
  buildDigest,
  renderWhole,
  renderDigestNotice,
  renderDigestBanner,
  findSections,
  selectSections,
  parseSectionFlag,
  classifyHeading,
  flattenSections,
  sectionText,
  slugify,
} from './knowledge-sections.js';

// Pure string-in/structure-out module: no home-directory access, no sandbox needed.

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-support', 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(fixturesDir, name), 'utf-8');

const GITHUB = fixture('knowledge-github-create-issue.md'); // ~25k, canonical template
const STRIPE = fixture('knowledge-stripe-create-customer.md'); // ~10k, canonical template
const GMAIL = fixture('knowledge-gmail-send-email.md'); // ~10k, custom-action template

describe('parseSections', () => {
  it('takes the first H1 as the title and promotes its H2s to top level', () => {
    const doc = parseSections(GITHUB);
    assert.equal(doc.title, 'Create an Issue for a Repository');
    assert.equal(doc.preface, '');
    assert.deepEqual(
      doc.sections.map((s) => s.heading).slice(0, 6),
      ['Prerequisites', 'Method', 'URL', 'Headers', 'Description', 'Enforcement Rules']
    );
    assert.ok(doc.sections.every((s) => s.level === 2));
  });

  it('nests H3s under their H2', () => {
    const doc = parseSections(GITHUB);
    const response = doc.sections.find((s) => s.heading === 'Response')!;
    assert.equal(response.children.length, 7);
    assert.equal(response.children[0].heading, 'Success Response (201 Created)');
    assert.ok(response.children.slice(1).every((c) => c.heading.startsWith('Error Response')));
  });

  it('handles the custom-action template (Endpoint + Request Body with H3 children)', () => {
    const doc = parseSections(GMAIL);
    assert.equal(doc.title, 'Send Email');
    const body = doc.sections.find((s) => s.heading === 'Request Body')!;
    assert.deepEqual(
      body.children.map((c) => c.heading),
      ['Required Request Body Fields', 'Optional Request Body Fields']
    );
  });

  it('round-trips: rendering the whole tree reproduces the source text', () => {
    for (const src of [GITHUB, STRIPE, GMAIL]) {
      const doc = parseSections(src);
      // Rendering joins blocks with a blank line, so compare modulo blank-line runs.
      const norm = (s: string) => s.replace(/\n{2,}/g, '\n').trim();
      assert.equal(norm(renderWhole(doc)), norm(src));
    }
  });

  it('ignores # lines inside fenced code blocks', () => {
    const md = ['# T', '', '## Real', '```bash', '# not a heading', '~~~ still inside', '```', 'after', '## Next', ''].join('\n');
    const doc = parseSections(md);
    assert.deepEqual(doc.sections.map((s) => s.heading), ['Real', 'Next']);
    assert.ok(doc.sections[0].text.includes('# not a heading'));
  });

  it('keeps a second H1 as a top-level section rather than a new title', () => {
    const md = '# One\n\n## A\ntext\n\n# Two\n\n## B\nmore\n';
    const doc = parseSections(md);
    assert.equal(doc.title, 'One');
    assert.deepEqual(doc.sections.map((s) => `${s.level}:${s.heading}`), ['2:A', '1:Two']);
    assert.equal(doc.sections[1].children[0].heading, 'B');
  });

  it('returns no sections and an empty title for text without headings', () => {
    const doc = parseSections('just prose\nno headings');
    assert.equal(doc.title, '');
    assert.equal(doc.sections.length, 0);
    assert.equal(doc.preface, 'just prose\nno headings');
  });

  it('de-duplicates ids and slugs headings predictably', () => {
    assert.equal(slugify('Success Response (201 Created)'), 'success-response-201-created');
    assert.equal(slugify('Optional Request Body Fields (application/x-www-form-urlencoded)'), 'optional-request-body-fields-application-x-www-form-urlencoded');
    const doc = parseSections('# T\n## Notes\n## Notes\n## Notes\n');
    assert.deepEqual(doc.sections.map((s) => s.id), ['notes', 'notes-2', 'notes-3']);
  });

  it('measures chars including children', () => {
    const doc = parseSections(GITHUB);
    const response = doc.sections.find((s) => s.heading === 'Response')!;
    assert.equal(response.chars, sectionText(response).length + 0 || response.chars);
    assert.ok(response.chars > 15_000, `response subtree is ${response.chars}`);
    const total = doc.sections.reduce((n, s) => n + s.chars, 0);
    assert.ok(total <= GITHUB.length && total > GITHUB.length * 0.95);
  });
});

describe('classifyHeading', () => {
  it('marks request-building sections essential and the size drivers deferred', () => {
    const essential = ['Method', 'URL', 'Endpoint', 'Headers', 'Description', 'Prerequisites', 'Enforcement Rules',
      'Required Path Parameters', 'Required Request Body Fields', 'Required Query Parameters', 'Request Body',
      'Sample Request', 'Gotchas', 'Error Handling'];
    const deferred = ['Response', 'Success Response (201 Created)', 'Error Response (404 Not Found)', 'Response Fields',
      'Optional Request Body Fields', 'Optional Request Body Fields (application/x-www-form-urlencoded)',
      'Optional Query Parameters', 'Example Usage', 'Example 1: Simple Message', 'Behavior', 'Notes', 'Document.footnotes'];
    for (const h of essential) assert.equal(classifyHeading(h), 'essential', h);
    for (const h of deferred) assert.equal(classifyHeading(h), 'deferred', h);
  });
});

describe('buildDigest', () => {
  it('returns small documents whole, untruncated, with every section flagged included', () => {
    const doc = parseSections(STRIPE);
    const d = buildDigest(doc, { wholeDocThreshold: 20_000 });
    assert.equal(d.truncated, false);
    assert.equal(d.omitted, 0);
    assert.equal(d.omittedChars, 0);
    assert.ok(d.sections.every((s) => s.included === true));
    assert.equal(d.sections.length, flattenSections(doc.sections).length);
    assert.ok(d.markdown.includes('## Optional Request Body Fields'));
  });

  it('returns a document with no headings whole', () => {
    const d = buildDigest(parseSections('a'.repeat(50_000)));
    assert.equal(d.truncated, false);
    assert.equal(d.markdown.length, 50_000);
  });

  it('keeps essentials, defers the big Response block, and lists everything omitted', () => {
    const doc = parseSections(GITHUB);
    const d = buildDigest(doc);
    assert.equal(d.truncated, true);
    assert.ok(d.markdown.length < GITHUB.length / 2, `digest is ${d.markdown.length} of ${GITHUB.length}`);

    const status = Object.fromEntries(d.sections.map((s) => [s.heading, s.included]));
    for (const h of ['Prerequisites', 'Method', 'URL', 'Headers', 'Description', 'Enforcement Rules',
      'Required Path Parameters', 'Required Request Body Fields', 'Sample Request', 'Gotchas', 'Error Handling']) {
      assert.equal(status[h], true, h);
    }
    assert.equal(status['Success Response (201 Created)'], false);
    assert.equal(status['Response Fields'], false);
    assert.ok(!d.markdown.includes('### Success Response (201 Created)'));
    assert.ok(d.markdown.includes('## Required Request Body Fields'));

    // The TOC covers every section, not just the omitted ones.
    assert.equal(d.sections.length, flattenSections(doc.sections).length);
    assert.ok(d.omitted > 0);
    assert.ok(d.omittedChars > 15_000);
  });

  it('back-fills deferred sections in priority order while they fit the budget', () => {
    const doc = parseSections(GITHUB);
    const d = buildDigest(doc, { wholeDocThreshold: 0, budget: 8_000 });
    const status = Object.fromEntries(d.sections.map((s) => [s.heading, s.included]));
    // Optional fields (~1k) fit and are the first to be pulled back in.
    assert.equal(status['Optional Request Body Fields'], true);
    // The 15k success response never fits an 8k budget.
    assert.equal(status['Success Response (201 Created)'], false);

    const tight = buildDigest(doc, { wholeDocThreshold: 0, budget: 0 });
    const tightStatus = Object.fromEntries(tight.sections.map((s) => [s.heading, s.included]));
    assert.equal(tightStatus['Optional Request Body Fields'], false);
    assert.equal(tightStatus['Method'], true, 'essentials survive a zero budget');
  });

  it('cuts an oversized essential section and marks it partial', () => {
    const big = '# T\n\n## Method\nPOST\n\n## Required Request Body Fields\n' + '| a | b |\n'.repeat(2_000) + '\n## Notes\nn\n';
    const doc = parseSections(big);
    const d = buildDigest(doc, { wholeDocThreshold: 0, sectionCap: 500, budget: 0 });
    const req = d.sections.find((s) => s.heading === 'Required Request Body Fields')!;
    assert.equal(req.included, 'partial');
    assert.ok(d.markdown.includes('_[truncated'));
    assert.ok(d.markdown.includes('--section required-request-body-fields'));
    assert.ok(d.truncated);
    assert.ok(d.omittedChars > 15_000);
  });

  it('keeps essential children of an essential parent but defers deferred children (custom template)', () => {
    const doc = parseSections(GMAIL);
    const d = buildDigest(doc, { wholeDocThreshold: 0, budget: 0 });
    const status = Object.fromEntries(d.sections.map((s) => [s.heading, s.included]));
    assert.equal(status['Request Body'], true);
    assert.equal(status['Required Request Body Fields'], true);
    assert.equal(status['Optional Request Body Fields'], false);
    assert.ok(d.markdown.includes('### Required Request Body Fields'));
    assert.ok(!d.markdown.includes('### Optional Request Body Fields'));
  });

  it('keeps required fields nested under a deferred sub-heading (Notion option layout)', () => {
    const md = [
      '# Update Page', '', '## Method', 'PATCH', '', '## Request Body', 'Pick one option.', '',
      '### Option A: Replace everything', '#### Required Request Body Fields (Replace)', '| a |', '#### Optional Fields (Replace)', '| opt |',
      '### Option B: Search and replace', 'intro b', '#### Required Fields inside `update_content`', '| b |', '#### Examples for B', 'ex',
      '## Response', 'x'.repeat(9_000), '',
    ].join('\n');
    const d = buildDigest(parseSections(md), { wholeDocThreshold: 0, budget: 0 });
    const st = Object.fromEntries(d.sections.map((s) => [s.heading, s.included]));
    assert.equal(st['Option A: Replace everything'], true, 'scaffolding kept');
    assert.equal(st['Required Request Body Fields (Replace)'], true);
    assert.equal(st['Optional Fields (Replace)'], false);
    assert.equal(st['Option B: Search and replace'], true);
    assert.equal(st['Required Fields inside `update_content`'], true);
    assert.equal(st['Examples for B'], false);
    assert.equal(st['Response'], false);
    assert.ok(d.markdown.includes('intro b'));
    assert.ok(!d.markdown.includes('| opt |'));
  });

  it('never back-fills appended H1 chunks even when they would fit the budget', () => {
    const md = [
      '# Action', '', '## Method', 'POST', '', '## Response', 'r'.repeat(9_000), '',
      '# Data Models — Chunk 2/7', '', '# TinyType', '## Description', 'small', '## Fields', '| f |', '',
    ].join('\n');
    const d = buildDigest(parseSections(md), { wholeDocThreshold: 0, budget: 100_000 });
    const st = Object.fromEntries(d.sections.map((s) => [s.heading, s.included]));
    assert.equal(st['Response'], true, 'H2 deferred sections are back-filled');
    assert.equal(st['TinyType'], false, 'appendix H1s are not');
    assert.equal(st['Data Models — Chunk 2/7'], false);
    assert.ok(d.truncated);
  });

  it('treats GraphQL request-building headings as essential', () => {
    for (const h of ['GraphQL Operation', 'Request Variables', 'Path Parameters', 'Query Parameters']) {
      assert.equal(classifyHeading(h), 'essential', h);
    }
    assert.equal(classifyHeading('Type'), 'deferred');
  });

  it('falls back to the whole document when the digest would include everything anyway', () => {
    const doc = parseSections(STRIPE);
    const d = buildDigest(doc, { wholeDocThreshold: 0, budget: 1_000_000 });
    assert.equal(d.truncated, false);
    assert.equal(d.markdown, renderWhole(doc));
  });
});

describe('renderDigestNotice', () => {
  it('is empty for an untruncated digest', () => {
    const d = buildDigest(parseSections(STRIPE), { wholeDocThreshold: 1_000_000 });
    assert.equal(renderDigestNotice(d, 'stripe', 'id'), '');
  });

  it('names only top-most omitted sections and shows both load commands', () => {
    const d = buildDigest(parseSections(GITHUB), { wholeDocThreshold: 0, budget: 0 });
    const notice = renderDigestNotice(d, 'github', 'conn_mod_def::X::Y');
    assert.match(notice, /This is a digest, not the full document/);
    assert.match(notice, /one --agent actions knowledge github conn_mod_def::X::Y --section "/);
    assert.match(notice, /one --agent actions knowledge github conn_mod_def::X::Y --full/);
    assert.ok(notice.includes('Response,') || notice.includes('Response.'), 'lists the omitted Response parent');
    assert.ok(!notice.includes('Success Response (201 Created)'), 'children of an omitted parent are implied');
    assert.ok(notice.includes('Response Fields'));
  });
});

describe('renderDigestBanner', () => {
  it('is empty when nothing was omitted and one line otherwise', () => {
    assert.equal(renderDigestBanner(buildDigest(parseSections(STRIPE), { wholeDocThreshold: 1_000_000 })), '');
    const b = renderDigestBanner(buildDigest(parseSections(GITHUB), { wholeDocThreshold: 0, budget: 0 }));
    assert.match(b, /^> \*\*Digest\.\*\* \d+ sections \([\d,]+ chars\) omitted/);
    assert.ok(!b.includes('\n'));
  });
});

describe('findSections / selectSections', () => {
  const doc = parseSections(GITHUB);
  const headings = (r: ReturnType<typeof findSections>) => (r.ok ? r.sections.map((s) => s.heading) : r);

  it('matches by id, exact heading, and case-insensitive heading', () => {
    assert.deepEqual(headings(findSections(doc, 'response-fields')), ['Response Fields']);
    assert.deepEqual(headings(findSections(doc, 'Response Fields')), ['Response Fields']);
    assert.deepEqual(headings(findSections(doc, '"response fields"')), ['Response Fields']);
    assert.deepEqual(headings(findSections(doc, 'success response')), ['Success Response (201 Created)']);
  });

  it('resolves aliases to groups', () => {
    assert.deepEqual(headings(findSections(doc, 'optional')), ['Optional Request Body Fields']);
    assert.deepEqual(headings(findSections(doc, 'required')), ['Required Path Parameters', 'Required Request Body Fields']);
    assert.deepEqual(headings(findSections(doc, 'examples')), ['Example Usage']);
    const errors = headings(findSections(doc, 'errors')) as string[];
    assert.ok(errors.length >= 6 && errors.includes('Error Handling'));
  });

  it('a parent match carries its children', () => {
    const r = selectSections(doc, ['response']);
    assert.ok(r.ok);
    assert.ok(r.markdown.includes('### Success Response (201 Created)'));
    assert.ok(r.markdown.includes('### Error Response (404 Resource not found)'));
    assert.ok(r.markdown.startsWith('# Create an Issue for a Repository'));
  });

  it('prefix matches that all share a canonical name return the group', () => {
    const r = findSections(doc, 'error response');
    assert.ok(r.ok);
    assert.equal(r.sections.length, 6);
  });

  it('an ambiguous prefix returns candidates rather than guessing', () => {
    const r = findSections(doc, 'e');
    assert.ok(!r.ok);
    assert.equal(r.reason, 'ambiguous');
    assert.ok(r.candidates.length > 1);
  });

  it('an unknown name returns not-found with the full section list', () => {
    const r = findSections(doc, 'pricing');
    assert.ok(!r.ok);
    assert.equal(r.reason, 'not-found');
    assert.equal(r.candidates.length, flattenSections(doc.sections).length);
  });

  it('selectSections accepts several names, dedupes, and orders by document position', () => {
    const r = selectSections(doc, ['notes', 'Method', 'success-response-201-created', 'response']);
    assert.ok(r.ok);
    assert.deepEqual(r.sections.map((s) => s.heading), ['Method', 'Response', 'Notes']);
  });

  it('selectSections reports the first bad name', () => {
    const r = selectSections(doc, ['method', 'nope']);
    assert.ok(!r.ok);
    assert.equal(r.query, 'nope');
  });
});

describe('parseSectionFlag', () => {
  it('splits repeated flags and comma lists', () => {
    assert.deepEqual(parseSectionFlag(undefined), []);
    assert.deepEqual(parseSectionFlag('a, b'), ['a', 'b']);
    assert.deepEqual(parseSectionFlag(['a,b', ' c ', '']), ['a', 'b', 'c']);
  });
});

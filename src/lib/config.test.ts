import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getProjectSlug } from './config.js';

describe('getProjectSlug', () => {
  it('encodes a POSIX absolute path by replacing path separators', () => {
    assert.equal(getProjectSlug('/Users/jane/projects/acme'), '-Users-jane-projects-acme');
  });

  it('replaces the Windows drive-letter colon (INT-2828)', () => {
    // Pre-fix this produced `C:-Users-DeathStalker`, which mkdirSync
    // rejects on NTFS because `:` is forbidden inside a path component.
    const slug = getProjectSlug('C:\\Users\\DeathStalker');
    assert.equal(slug, 'C--Users-DeathStalker');
    assert.equal(slug.includes(':'), false, 'slug must not contain ":" on Windows');
  });

  it('replaces a colon anywhere in the path, not just the drive letter', () => {
    assert.equal(getProjectSlug('/tmp/some:weird/dir'), '-tmp-some-weird-dir');
  });

  it('handles mixed forward and backward slashes (Windows MSYS / WSL boundary)', () => {
    assert.equal(getProjectSlug('C:\\Users\\jane/projects'), 'C--Users-jane-projects');
  });

  it('replaces every Windows-forbidden character (< > : " | ? *)', () => {
    // None of these would normally appear in a path the CLI sees (Windows
    // forbids them in components), but stripping them defensively keeps
    // the slug a valid filename on any OS regardless of how it was
    // constructed.
    assert.equal(getProjectSlug('a<b>c:d"e|f?g*h'), 'a-b-c-d-e-f-g-h');
  });

  it('is idempotent — re-encoding an already-encoded slug is a no-op', () => {
    const slug = getProjectSlug('C:\\Users\\jane');
    assert.equal(getProjectSlug(slug), slug);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectIdentityKeys } from './mem-writer.js';
import { loadBuiltinProfile } from './builtin-profiles.js';
import type { SyncProfile } from './types.js';

// #128: identityKeys (plural) — multiple cross-platform identity keys per
// record, with [] wildcard fan-out, normalization, and dedupe. The singular
// identityKey must keep its original scalar behavior (backwards compatible).

type IdProfile = Pick<SyncProfile, 'identityKey' | 'identityKeys'>;

describe('collectIdentityKeys — singular identityKey (backwards compatible) (#128)', () => {
  it('extracts a scalar identity key, lowercased + trimmed, with derived prefix', () => {
    const keys = collectIdentityKeys({ email: '  Jane@Acme.COM ' }, { identityKey: 'email' } as IdProfile);
    assert.deepEqual(keys, ['email:jane@acme.com']);
  });

  it('derives prefix from the path (email/phone/domain/id)', () => {
    assert.deepEqual(collectIdentityKeys({ work_phone: '+1-555' }, { identityKey: 'work_phone' } as IdProfile), ['phone:+1-555']);
    assert.deepEqual(collectIdentityKeys({ company_domain: 'Acme.com' }, { identityKey: 'company_domain' } as IdProfile), ['domain:acme.com']);
    assert.deepEqual(collectIdentityKeys({ ref: 'ABC' }, { identityKey: 'ref' } as IdProfile), ['id:abc']);
  });

  it('resolves dotted + numeric-index paths', () => {
    const rec = { email_addresses: [{ email_address: 'a@b.com' }] };
    assert.deepEqual(collectIdentityKeys(rec, { identityKey: 'email_addresses[0].email_address' } as IdProfile), ['email:a@b.com']);
  });

  it('produces no key when the value is missing/empty/object', () => {
    assert.deepEqual(collectIdentityKeys({}, { identityKey: 'email' } as IdProfile), []);
    assert.deepEqual(collectIdentityKeys({ email: '' }, { identityKey: 'email' } as IdProfile), []);
    assert.deepEqual(collectIdentityKeys({ email: { nested: 1 } }, { identityKey: 'email' } as IdProfile), []);
  });

  it('returns [] when no identity config is set', () => {
    assert.deepEqual(collectIdentityKeys({ email: 'a@b.com' }, {} as IdProfile), []);
  });
});

describe('collectIdentityKeys — plural identityKeys with [] wildcard (#128)', () => {
  it('fans out a [] wildcard path to one key per element', () => {
    const rec = { attendees: [{ email: 'A@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }] };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'attendees[].email' }] } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com', 'email:b@x.com', 'email:c@x.com']);
  });

  it('handles nested [] wildcards (messages[].headers[].value)', () => {
    const rec = {
      messages: [
        { headers: [{ value: 'one@x.com' }, { value: 'two@x.com' }] },
        { headers: [{ value: 'three@x.com' }] },
      ],
    };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'messages[].headers[].value' }] } as IdProfile);
    assert.deepEqual(keys, ['email:one@x.com', 'email:two@x.com', 'email:three@x.com']);
  });

  it('dedupes repeats within and across entries (order-preserving)', () => {
    const rec = {
      organizer: { email: 'host@x.com' },
      attendees: [{ email: 'host@x.com' }, { email: 'guest@x.com' }, { email: 'GUEST@x.com' }],
    };
    const keys = collectIdentityKeys(rec, {
      identityKeys: [
        { prefix: 'email', path: 'organizer.email' },
        { prefix: 'email', path: 'attendees[].email' },
      ],
    } as IdProfile);
    assert.deepEqual(keys, ['email:host@x.com', 'email:guest@x.com']);
  });

  it('respects each entry\'s prefix', () => {
    const rec = { primary: 'a@x.com', site: 'acme.com' };
    const keys = collectIdentityKeys(rec, {
      identityKeys: [
        { prefix: 'email', path: 'primary' },
        { prefix: 'domain', path: 'site' },
      ],
    } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com', 'domain:acme.com']);
  });

  it('skips null/empty elements in a wildcard array', () => {
    const rec = { attendees: [{ email: 'a@x.com' }, { email: '' }, { email: null }, { other: 1 }, { email: 'b@x.com' }] };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'attendees[].email' }] } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com', 'email:b@x.com']);
  });

  it('ignores malformed entries (missing prefix or path)', () => {
    const rec = { email: 'a@x.com' };
    const keys = collectIdentityKeys(rec, {
      identityKeys: [
        { prefix: '', path: 'email' } as any,
        { prefix: 'email', path: '' } as any,
        { prefix: 'email', path: 'email' },
      ],
    } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com']);
  });
});

describe('collectIdentityKeys — email extraction from header values (#129)', () => {
  it('strips display names and lowercases', () => {
    const rec = { from: 'Jane Smith <Jane@Acme.com>' };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'from' }] } as IdProfile);
    assert.deepEqual(keys, ['email:jane@acme.com']);
  });

  it('extracts every address from a comma-list (To/Cc)', () => {
    const rec = { to: 'a@x.com, Bob <b@y.com>, c@z.com' };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'to' }] } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com', 'email:b@y.com', 'email:c@z.com']);
  });

  it('passes already-clean emails through unchanged (gcal attendees — #130)', () => {
    const rec = { attendees: [{ email: 'jane@acme.com' }, { email: 'BOB@acme.com' }] };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'attendees[].email' }] } as IdProfile);
    assert.deepEqual(keys, ['email:jane@acme.com', 'email:bob@acme.com']);
  });

  it('yields nothing for an email-prefixed value with no address', () => {
    const rec = { from: 'mailer-daemon (no address)' };
    assert.deepEqual(collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'from' }] } as IdProfile), []);
  });
});

describe('collectIdentityKeys — [name=From] header filter (#129 Gmail shape)', () => {
  const thread = {
    messages: [
      { payload: { headers: [
        { name: 'From', value: 'Moe <moe@withone.ai>' },
        { name: 'To', value: 'anish@intently.ai, jane@acme.com' },
        { name: 'Subject', value: 'pricing for vip@whale.com' }, // must NOT leak
        { name: 'Received', value: 'by mail-server@google.com' }, // must NOT leak
      ] } },
      { payload: { headers: [
        { name: 'From', value: 'anish@intently.ai' },
        { name: 'Cc', value: 'Boss <boss@acme.com>' },
      ] } },
    ],
  };

  it('extracts From/To/Cc participants across all messages, ignoring other headers', () => {
    const keys = collectIdentityKeys(thread, {
      identityKeys: [
        { prefix: 'email', path: "messages[].payload.headers[name=From].value" },
        { prefix: 'email', path: "messages[].payload.headers[name=To].value" },
        { prefix: 'email', path: "messages[].payload.headers[name=Cc].value" },
      ],
    } as IdProfile);
    assert.deepEqual(keys, [
      'email:moe@withone.ai',
      'email:anish@intently.ai',
      'email:jane@acme.com',
      'email:boss@acme.com',
    ]);
    // Subject/Received emails must be absent
    assert.ok(!keys.includes('email:vip@whale.com'));
    assert.ok(!keys.includes('email:mail-server@google.com'));
  });

  it('filter is case-insensitive on the field value', () => {
    const rec = { headers: [{ name: 'from', value: 'x@y.com' }] };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'headers[name=From].value' }] } as IdProfile);
    assert.deepEqual(keys, ['email:x@y.com']);
  });
});

describe('built-in profiles declare working identity keys (#129/#130)', () => {
  it('gmail/gmailThreads resolves From/To/Cc participants across the thread', () => {
    const profile = loadBuiltinProfile('gmail', 'gmailThreads') as unknown as SyncProfile;
    assert.ok(profile?.identityKeys?.length, 'gmail profile declares identityKeys');
    const thread = {
      messages: [
        { payload: { headers: [
          { name: 'From', value: 'Moe <moe@withone.ai>' },
          { name: 'To', value: 'anish@intently.ai, jane@acme.com' },
          { name: 'Subject', value: 'note to self@nope.com' },
        ] } },
        { payload: { headers: [{ name: 'Cc', value: 'Boss <boss@acme.com>' }] } },
      ],
    };
    const keys = collectIdentityKeys(thread, profile);
    assert.deepEqual(keys.sort(), ['email:anish@intently.ai', 'email:boss@acme.com', 'email:jane@acme.com', 'email:moe@withone.ai'].sort());
    assert.ok(!keys.includes('email:self@nope.com'), 'Subject email must not leak');
  });

  it('google-calendar/events resolves organizer + attendees', () => {
    const profile = loadBuiltinProfile('google-calendar', 'events') as unknown as SyncProfile;
    assert.ok(profile?.identityKeys?.length, 'gcal profile declares identityKeys');
    const event = { organizer: { email: 'Host@acme.com' }, attendees: [{ email: 'a@x.com' }, { email: 'b@y.com' }] };
    assert.deepEqual(collectIdentityKeys(event, profile).sort(), ['email:a@x.com', 'email:b@y.com', 'email:host@acme.com'].sort());
  });

  it('fathom/meetings resolves host + calendar invitees', () => {
    const profile = loadBuiltinProfile('fathom', 'meetings') as unknown as SyncProfile;
    assert.ok(profile?.identityKeys?.length, 'fathom profile declares identityKeys');
    const meeting = { recorded_by: { email: 'rec@acme.com' }, calendar_invitees: [{ email: 'x@y.com' }] };
    assert.deepEqual(collectIdentityKeys(meeting, profile).sort(), ['email:rec@acme.com', 'email:x@y.com'].sort());
  });
});

describe('collectIdentityKeys — singular + plural combined (#128)', () => {
  it('merges both sources and dedupes the overlap (prefix from singular path name)', () => {
    // Singular `from_email` derives the `email` prefix (path name contains
    // "email"), so it dedupes against the plural `email:` keys.
    const rec = { from_email: 'me@x.com', to: [{ email: 'me@x.com' }, { email: 'you@x.com' }] };
    const keys = collectIdentityKeys(rec, {
      identityKey: 'from_email',
      identityKeys: [{ prefix: 'email', path: 'to[].email' }],
    } as IdProfile);
    assert.deepEqual(keys, ['email:me@x.com', 'email:you@x.com']);
  });
});

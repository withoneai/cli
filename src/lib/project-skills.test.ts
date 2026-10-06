import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { withTempHome, assertHomeIsSandboxed } from '../test-support/home.js';
import {
  OPTIONAL_SKILLS,
  SKILL_STAMP,
  findInstalledPackage,
  findOptionalSkill,
  findProjectRoot,
  installSkill,
  installedSkill,
  matchesIntegrity,
  projectSkillSource,
  readStamp,
  readTarEntries,
  refreshProjectSkills,
  registrySkillSource,
  removeSkill,
  SkillSourceError,
} from './project-skills.js';

const connect = findOptionalSkill('connect')!;
const home = withTempHome();

/** A project folder with @withone/connect at `version` in node_modules. */
function makeProject(version: string | null, opts: { withSkill?: boolean; markers?: string[] } = {}): string {
  const root = path.join(home.dir, 'work', 'acme-app');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme-app' }));
  if (version) setPackage(root, version, opts.withSkill ?? true);
  for (const marker of opts.markers ?? []) fs.mkdirSync(path.join(root, marker), { recursive: true });
  return root;
}

function setPackage(root: string, version: string, withSkill = true): void {
  const pkg = path.join(root, 'node_modules', '@withone', 'connect');
  fs.rmSync(pkg, { recursive: true, force: true });
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@withone/connect', version }));
  if (withSkill) {
    const dir = path.join(pkg, 'skills', 'one-connect');
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: one-connect\n---\n# One Connect ${version}\n`);
    fs.writeFileSync(path.join(dir, 'references', 'extra.md'), 'extra');
  }
}

const read = (p: string) => fs.readFileSync(p, 'utf-8');

beforeEach(() => { home.setup(); assertHomeIsSandboxed(); });
afterEach(() => home.teardown());

describe('the optional skill registry', () => {
  it('knows Connect by its short and its folder name, and nothing else', () => {
    assert.equal(findOptionalSkill('connect'), findOptionalSkill('one-connect'));
    assert.equal(findOptionalSkill('one'), undefined, 'the One skill stays with one init');
    assert.equal(OPTIONAL_SKILLS.length, 1);
  });
});

describe('step 1: finding the skill', () => {
  it('finds the project root and the package hoisted above a nested folder', () => {
    const root = makeProject('0.16.0');
    const nested = path.join(root, 'packages', 'web', 'src');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findProjectRoot(nested), root);
    assert.deepEqual(findInstalledPackage(nested, '@withone/connect')?.version, '0.16.0');
  });

  it('uses the version the project installed', () => {
    const root = makeProject('0.16.0');
    const source = projectSkillSource(connect, root)!;
    assert.equal(source.kind, 'project');
    assert.equal(source.version, '0.16.0');
    assert.ok(fs.existsSync(path.join(source.dir, 'SKILL.md')));
  });

  it('is null when the project does not have the package', () => {
    assert.equal(projectSkillSource(connect, makeProject(null)), null);
  });

  it('refuses an installed version that predates the skill, naming the upgrade', () => {
    const root = makeProject('0.8.0', { withSkill: false });
    assert.throws(() => projectSkillSource(connect, root), (err: unknown) =>
      err instanceof SkillSourceError && err.code === 'skill-missing' && /npm install @withone\/connect@latest/.test(err.message));
  });
});

describe('steps 2 and 3: installing into a project', () => {
  it('copies to .agents/skills, links Claude Code, and stamps the version', () => {
    const root = makeProject('0.16.0');
    const result = installSkill(connect, projectSkillSource(connect, root)!, { scope: 'project', root, agents: [] }, '9.9.9');

    const canonical = path.join(root, '.agents', 'skills', 'one-connect');
    assert.equal(result.canonical, canonical);
    assert.match(read(path.join(canonical, 'SKILL.md')), /One Connect 0\.16\.0/);
    assert.equal(read(path.join(canonical, 'references', 'extra.md')), 'extra');
    assert.deepEqual(result.readers, ['Codex', 'Cursor', 'Amp', 'OpenCode']);

    const claude = path.join(root, '.claude', 'skills', 'one-connect');
    assert.match(read(path.join(claude, 'SKILL.md')), /One Connect 0\.16\.0/);
    assert.deepEqual(result.links.map(l => l.agents), [['Claude Code']]);

    const stamp = readStamp(canonical)!;
    assert.equal(stamp.version, '0.16.0');
    assert.equal(stamp.source, 'project');
    assert.equal(stamp.installedBy, '@withone/cli@9.9.9');
  });

  it('links Windsurf, Kiro, Goose or Roo only when the project uses them', () => {
    const root = makeProject('0.16.0', { markers: ['.windsurf'] });
    const result = installSkill(connect, projectSkillSource(connect, root)!, { scope: 'project', root, agents: [] }, '1.0.0');
    assert.deepEqual(result.links.map(l => l.path).sort(), ['.claude/skills/one-connect', '.windsurf/skills/one-connect']);
    assert.ok(!fs.existsSync(path.join(root, '.kiro')));
  });

  it('links exactly the agents asked for with --agents', () => {
    const root = makeProject('0.16.0');
    const result = installSkill(connect, projectSkillSource(connect, root)!, { scope: 'project', root, agents: ['roo'] }, '1.0.0');
    assert.deepEqual(result.links.map(l => l.agents), [['Roo']]);
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills', 'one-connect')));
  });

  it('a second add replaces the first and drops links no longer asked for', () => {
    const root = makeProject('0.16.0');
    const source = projectSkillSource(connect, root)!;
    installSkill(connect, source, { scope: 'project', root, agents: ['claude-code', 'roo'] }, '1.0.0');
    installSkill(connect, source, { scope: 'project', root, agents: ['claude-code'] }, '1.0.0');
    assert.ok(!fs.existsSync(path.join(root, '.roo', 'skills', 'one-connect')));
    assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'one-connect', 'SKILL.md')));
  });

  it('never touches other skills in the same folders', () => {
    const root = makeProject('0.16.0');
    const other = path.join(root, '.agents', 'skills', 'someone-else');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'SKILL.md'), 'theirs');
    installSkill(connect, projectSkillSource(connect, root)!, { scope: 'project', root, agents: [] }, '1.0.0');
    removeSkill(connect, { scope: 'project', root });
    assert.equal(read(path.join(other, 'SKILL.md')), 'theirs');
  });
});

describe('step 4: keeping a project install fresh', () => {
  it('re-copies when the installed package version moves, keeping the same agents', () => {
    const root = makeProject('0.16.0', { markers: ['.windsurf'] });
    installSkill(connect, projectSkillSource(connect, root)!, { scope: 'project', root, agents: [] }, '1.0.0');
    setPackage(root, '0.17.0');

    const results = refreshProjectSkills(path.join(root, 'src'), '1.0.0');
    assert.deepEqual(results.map(r => [r.skill, r.from, r.to]), [['connect', '0.16.0', '0.17.0']]);
    assert.match(read(path.join(root, '.agents', 'skills', 'one-connect', 'SKILL.md')), /0\.17\.0/);
    assert.match(read(path.join(root, '.windsurf', 'skills', 'one-connect', 'SKILL.md')), /0\.17\.0/);
    assert.equal(readStamp(path.join(root, '.agents', 'skills', 'one-connect'))!.version, '0.17.0');
  });

  it('does nothing when the version did not move, or nothing is installed', () => {
    const root = makeProject('0.16.0');
    assert.deepEqual(refreshProjectSkills(root, '1.0.0'), []);
    installSkill(connect, projectSkillSource(connect, root)!, { scope: 'project', root, agents: [] }, '1.0.0');
    const before = fs.statSync(path.join(root, '.agents', 'skills', 'one-connect', SKILL_STAMP)).mtimeMs;
    assert.deepEqual(refreshProjectSkills(root, '1.0.0'), []);
    assert.equal(fs.statSync(path.join(root, '.agents', 'skills', 'one-connect', SKILL_STAMP)).mtimeMs, before);
  });

  it('leaves a registry install alone (no network in the hook)', () => {
    const root = makeProject('0.16.0');
    const source = projectSkillSource(connect, root)!;
    installSkill(connect, { ...source, kind: 'registry' }, { scope: 'project', root, agents: [] }, '1.0.0');
    setPackage(root, '0.17.0');
    assert.deepEqual(refreshProjectSkills(root, '1.0.0'), []);
  });

  it('is a no-op outside any project and in the home folder', () => {
    assert.deepEqual(refreshProjectSkills(home.dir, '1.0.0'), []);
  });
});

describe('remove', () => {
  it('removes the folder and every agent folder it linked', () => {
    const root = makeProject('0.16.0', { markers: ['.kiro'] });
    installSkill(connect, projectSkillSource(connect, root)!, { scope: 'project', root, agents: [] }, '1.0.0');
    const result = removeSkill(connect, { scope: 'project', root });
    assert.equal(result.removed, true);
    for (const rel of ['.agents/skills/one-connect', '.claude/skills/one-connect', '.kiro/skills/one-connect']) {
      assert.ok(!fs.existsSync(path.join(root, rel)), rel);
    }
    assert.equal(installedSkill(connect, { scope: 'project', root }), null);
    assert.equal(removeSkill(connect, { scope: 'project', root }).removed, false);
  });
});

describe('stamps travel between machines', () => {
  it('reads link paths written with backslashes (a stamp committed on Windows)', () => {
    const root = makeProject('0.16.0');
    installSkill(connect, projectSkillSource(connect, root)!, { scope: 'project', root, agents: [] }, '1.0.0');
    const stampPath = path.join(root, '.agents', 'skills', 'one-connect', SKILL_STAMP);
    const stamp = JSON.parse(read(stampPath));
    stamp.links = stamp.links.map((l: { path: string }) => ({ ...l, path: l.path.split('/').join('\\') }));
    fs.writeFileSync(stampPath, JSON.stringify(stamp));
    removeSkill(connect, { scope: 'project', root });
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills', 'one-connect')));
  });
});

describe('global installs', () => {
  it('uses ~/.agents/skills and links only the agents this machine has', () => {
    fs.mkdirSync(path.join(home.dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home.dir, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home.dir, '.config'), { recursive: true }); // not Goose by itself
    const root = makeProject('0.16.0');
    const result = installSkill(connect, projectSkillSource(connect, root)!, { scope: 'global', root: home.dir, agents: [] }, '1.0.0');
    assert.equal(result.canonical, path.join(home.dir, '.agents', 'skills', 'one-connect'));
    assert.deepEqual(result.links.map(l => l.agents[0]).sort(), ['Claude Code', 'Codex']);
    assert.ok(fs.existsSync(path.join(home.dir, '.codex', 'skills', 'one-connect', 'SKILL.md')));
  });
});

// ── the registry fallback ──

/** A minimal ustar archive, enough for the reader. */
function tar(files: { name: string; body: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.body);
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100, 'utf-8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function fakeRegistry(tgz: Buffer, integrity: string) {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/@withone%2fconnect/latest')) {
      return new Response(JSON.stringify({ version: '0.16.0', dist: { tarball: 'https://registry.test/connect-0.16.0.tgz', integrity } }), { status: 200 });
    }
    if (u === 'https://registry.test/connect-0.16.0.tgz') return new Response(new Uint8Array(tgz), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const sri = (bytes: Buffer) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;

describe('the registry fallback', () => {
  const archive = () => zlib.gzipSync(tar([
    { name: 'package/package.json', body: '{"name":"@withone/connect","version":"0.16.0"}' },
    { name: 'package/skills/one-connect/SKILL.md', body: '# from npm' },
    { name: 'package/skills/one-connect/../../../escape.md', body: 'nope' },
    { name: 'package/README.md', body: 'readme' },
  ]));

  it('downloads the latest package, checks its integrity, and takes only the skill folder', async () => {
    const tgz = archive();
    const source = await registrySkillSource(connect, fakeRegistry(tgz, sri(tgz)));
    try {
      assert.equal(source.kind, 'registry');
      assert.equal(source.version, '0.16.0');
      assert.equal(read(path.join(source.dir, 'SKILL.md')), '# from npm');
      assert.deepEqual(fs.readdirSync(source.dir), ['SKILL.md']);
    } finally {
      source.cleanup();
    }
    assert.ok(!fs.existsSync(source.dir), 'temporary files removed');
  });

  it('installs nothing when the tarball does not match its integrity hash', async () => {
    const tgz = archive();
    await assert.rejects(
      registrySkillSource(connect, fakeRegistry(tgz, sri(Buffer.from('something else')))),
      (err: unknown) => err instanceof SkillSourceError && err.code === 'integrity',
    );
  });

  it('reports an unreachable registry plainly', async () => {
    await assert.rejects(
      registrySkillSource(connect, (async () => { throw new Error('offline'); }) as typeof fetch),
      (err: unknown) => err instanceof SkillSourceError && err.code === 'registry-failed' && /offline/.test(err.message),
    );
  });

  it('matches sha512 integrity strings the way npm publishes them', () => {
    const bytes = Buffer.from('abc');
    assert.equal(matchesIntegrity(bytes, sri(bytes)), true);
    assert.equal(matchesIntegrity(bytes, sri(Buffer.from('abd'))), false);
    assert.equal(matchesIntegrity(bytes, 'md5-xyz'), false);
  });

  it('reads only regular files under the prefix, never outside it', () => {
    const entries = readTarEntries(tar([
      { name: 'package/skills/one-connect/SKILL.md', body: 'a' },
      { name: 'package/skills/one-connect/sub/b.md', body: 'b' },
      { name: 'package/skills/one-connect/../x.md', body: 'x' },
      { name: 'package/other.md', body: 'o' },
    ]), 'package/skills/one-connect/');
    assert.deepEqual(entries.map(e => e.path), ['SKILL.md', 'sub/b.md']);
  });
});

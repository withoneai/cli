/**
 * Optional skills — installed on request with `one skills add <name>`,
 * beside the One skill that `one init` manages (lib/skill-sync.ts, which
 * this module never touches).
 *
 * An optional skill belongs to an SDK, not to the CLI: the Connect skill
 * ships inside the `@withone/connect` npm package and describes that
 * package's API. So the CLI never bundles a copy. It installs the skill
 * from the SDK version the project actually uses, which keeps what the
 * agent reads and the code it writes against on the same version.
 *
 *   one skills add connect
 *     1. find   ./node_modules/@withone/connect/skills/one-connect
 *               (not installed? the latest published package, integrity-checked)
 *     2. copy   → <project>/.agents/skills/one-connect     (Codex, Cursor, Amp, OpenCode)
 *        link   → <project>/.claude/skills/one-connect     (Claude Code)
 *               → .windsurf/.kiro/.goose/.roo when the project uses them
 *     3. stamp  → .one-skill.json: package version, source, links
 *     4. keep fresh: any `one` command in the project re-copies the skill
 *        when the installed package version moves (local files only, no network)
 *
 * Project folders per agent follow the open agent-skills layout used by
 * `npx skills` (v1.7.0). Global installs (`--global`) use the same home
 * folders `one init` uses for the One skill.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { homeDir } from './home.js';

export interface OptionalSkill {
  /** What the user types: `one skills add connect`. */
  name: string;
  /** The installed folder name, and the skill's `name:` frontmatter. */
  dirName: string;
  title: string;
  description: string;
  /** The npm package that ships the skill. */
  packageName: string;
  /** The skill's folder inside that package. */
  packagePath: string;
}

export const OPTIONAL_SKILLS: OptionalSkill[] = [
  {
    name: 'connect',
    dirName: 'one-connect',
    title: 'One Connect',
    description: "Add One Connect to an app: your users grant it scoped, revocable access to their own tools.",
    packageName: '@withone/connect',
    packagePath: 'skills/one-connect',
  },
];

export function findOptionalSkill(name: string): OptionalSkill | undefined {
  const wanted = name.trim().toLowerCase();
  return OPTIONAL_SKILLS.find(s => s.name === wanted || s.dirName === wanted);
}

// ── Where agents read skills ───────────────────────────────────────────

export interface SkillAgentTarget {
  id: string;
  name: string;
  /** Project folder the agent reads, relative to the project root. */
  projectDir: string;
  /** Folder whose presence in a project means the team uses this agent. */
  projectMarker: string | null;
  /** Home folder the agent reads (the same table `one init` uses). */
  homeDir: string;
}

/** `.agents/skills` is the shared project folder; the agents that read it
 *  need no link. The rest read their own folder. */
export const UNIVERSAL_PROJECT_DIR = '.agents/skills';

export const SKILL_AGENT_TARGETS: SkillAgentTarget[] = [
  { id: 'claude-code', name: 'Claude Code', projectDir: '.claude/skills', projectMarker: null, homeDir: '.claude/skills' },
  { id: 'codex', name: 'Codex', projectDir: UNIVERSAL_PROJECT_DIR, projectMarker: null, homeDir: '.codex/skills' },
  { id: 'cursor', name: 'Cursor', projectDir: UNIVERSAL_PROJECT_DIR, projectMarker: null, homeDir: '.cursor/skills' },
  { id: 'amp', name: 'Amp', projectDir: UNIVERSAL_PROJECT_DIR, projectMarker: null, homeDir: '.amp/skills' },
  { id: 'opencode', name: 'OpenCode', projectDir: UNIVERSAL_PROJECT_DIR, projectMarker: null, homeDir: '.opencode/skills' },
  { id: 'windsurf', name: 'Windsurf', projectDir: '.windsurf/skills', projectMarker: '.windsurf', homeDir: '.codeium/windsurf/skills' },
  { id: 'kiro', name: 'Kiro', projectDir: '.kiro/skills', projectMarker: '.kiro', homeDir: '.kiro/skills' },
  { id: 'goose', name: 'Goose', projectDir: '.goose/skills', projectMarker: '.goose', homeDir: '.config/goose/skills' },
  { id: 'roo', name: 'Roo', projectDir: '.roo/skills', projectMarker: '.roo', homeDir: '.roo/skills' },
];

export function findAgentTarget(id: string): SkillAgentTarget | undefined {
  return SKILL_AGENT_TARGETS.find(a => a.id === id.trim().toLowerCase());
}

// ── The project ────────────────────────────────────────────────────────

/** The nearest folder at or above `start` that holds a package.json or a
 *  .git, or null outside any project. */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The package as Node would resolve it from `start`: the nearest
 *  node_modules at or above it (monorepos hoist). */
export function findInstalledPackage(start: string, packageName: string): { dir: string; version: string } | null {
  let dir = path.resolve(start);
  for (;;) {
    const pkgDir = path.join(dir, 'node_modules', ...packageName.split('/'));
    const manifest = path.join(pkgDir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const { version } = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { version?: string };
        if (version) return { dir: pkgDir, version };
      } catch { /* unreadable manifest: keep looking up */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── Getting the skill files ────────────────────────────────────────────

export interface SkillSource {
  kind: 'project' | 'registry';
  version: string;
  /** A folder holding SKILL.md and its siblings. */
  dir: string;
  /** For `project`: the package folder. For `registry`: the tarball URL. */
  origin: string;
  /** Removes temporary files (registry downloads). */
  cleanup: () => void;
}

export class SkillSourceError extends Error {
  constructor(message: string, readonly code: 'skill-missing' | 'registry-failed' | 'integrity' | 'not-in-package') {
    super(message);
  }
}

/** The skill as shipped in the project's installed package, or null when
 *  the package is not installed there. Throws when the installed version
 *  predates the skill. */
export function projectSkillSource(skill: OptionalSkill, projectDir: string): SkillSource | null {
  const installed = findInstalledPackage(projectDir, skill.packageName);
  if (!installed) return null;
  const dir = path.join(installed.dir, ...skill.packagePath.split('/'));
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    throw new SkillSourceError(
      `${skill.packageName} ${installed.version} does not include the ${skill.title} skill. Upgrade it: npm install ${skill.packageName}@latest`,
      'skill-missing',
    );
  }
  return { kind: 'project', version: installed.version, dir, origin: installed.dir, cleanup: () => {} };
}

function registryBase(): string {
  return (process.env.ONE_SKILLS_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
}

/** The latest published package, downloaded and checked against the
 *  registry's integrity hash before a single file is read from it. */
export async function registrySkillSource(skill: OptionalSkill, fetchImpl: typeof fetch = fetch): Promise<SkillSource> {
  const metaUrl = `${registryBase()}/${skill.packageName.replace('/', '%2f')}/latest`;
  let meta: { version?: string; dist?: { tarball?: string; integrity?: string } };
  try {
    const res = await fetchImpl(metaUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    meta = await res.json() as typeof meta;
  } catch (err) {
    throw new SkillSourceError(`Could not reach the npm registry for ${skill.packageName} (${(err as Error).message}).`, 'registry-failed');
  }
  const version = meta.version;
  const tarball = meta.dist?.tarball;
  const integrity = meta.dist?.integrity;
  if (!version || !tarball || !integrity) {
    throw new SkillSourceError(`The npm registry returned no tarball for ${skill.packageName}.`, 'registry-failed');
  }

  let bytes: Buffer;
  try {
    const res = await fetchImpl(tarball);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new SkillSourceError(`Could not download ${skill.packageName}@${version} (${(err as Error).message}).`, 'registry-failed');
  }
  if (!matchesIntegrity(bytes, integrity)) {
    throw new SkillSourceError(`${skill.packageName}@${version} failed its integrity check; nothing was installed.`, 'integrity');
  }

  const files = readTarEntries(zlib.gunzipSync(bytes), `package/${skill.packagePath}/`);
  if (!files.some(f => f.path === 'SKILL.md')) {
    throw new SkillSourceError(`${skill.packageName}@${version} does not include the ${skill.title} skill.`, 'not-in-package');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-skill-'));
  for (const file of files) {
    const dest = path.join(tmp, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.data);
  }
  return {
    kind: 'registry',
    version,
    dir: tmp,
    origin: tarball,
    cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

/** Subresource-integrity check (`sha512-<base64>`, as npm publishes). */
export function matchesIntegrity(bytes: Buffer, integrity: string): boolean {
  return integrity.split(/\s+/).some(entry => {
    const dash = entry.indexOf('-');
    if (dash < 0) return false;
    const algorithm = entry.slice(0, dash);
    if (!['sha512', 'sha384', 'sha256'].includes(algorithm)) return false;
    return crypto.createHash(algorithm).update(bytes).digest('base64') === entry.slice(dash + 1);
  });
}

/** The regular files of a tar archive under `prefix`, with paths relative
 *  to it. Anything that would land outside the prefix is ignored. */
export function readTarEntries(tar: Buffer, prefix: string): { path: string; data: Buffer }[] {
  const out: { path: string; data: Buffer }[] = [];
  let offset = 0;
  let paxPath: string | null = null;
  const text = (start: number, length: number) => {
    const raw = tar.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? raw.length : end).toString('utf-8');
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    let name = text(offset, 100);
    if (text(offset + 257, 5) === 'ustar') {
      const pre = text(offset + 345, 155);
      if (pre) name = `${pre}/${name}`;
    }
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      const match = /\d+ path=([^\n]*)\n/.exec(body.toString('utf-8'));
      paxPath = match ? match[1] : null;
    } else {
      const full = paxPath ?? name;
      paxPath = null;
      if ((type === '0' || type === '\0') && full.startsWith(prefix)) {
        const rel = full.slice(prefix.length);
        const parts = rel.split('/');
        if (rel && !path.isAbsolute(rel) && !parts.includes('..') && !parts.includes('')) {
          out.push({ path: rel, data: Buffer.from(body) });
        }
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ── Installing ─────────────────────────────────────────────────────────

export const SKILL_STAMP = '.one-skill.json';

export interface SkillStamp {
  skill: string;
  package: string;
  version: string;
  source: 'project' | 'registry';
  scope: 'project' | 'global';
  /** Agent folders that point at the install: links, or copies where the
   *  filesystem refused a link. Relative to the root of the scope, with
   *  forward slashes on every OS. */
  links: { path: string; kind: 'symlink' | 'junction' | 'copy'; agents: string[] }[];
  installedBy: string;
  installedAt: string;
}

export interface InstallPlan {
  scope: 'project' | 'global';
  /** The project root, or the home folder for a global install. */
  root: string;
  /** Agents asked for with --agents; empty means the defaults. */
  agents: string[];
}

export interface InstallResult {
  skill: OptionalSkill;
  version: string;
  source: SkillSource['kind'];
  origin: string;
  scope: 'project' | 'global';
  root: string;
  canonical: string;
  /** Who reads the canonical folder directly (project scope only). */
  readers: string[];
  links: SkillStamp['links'];
}

export function canonicalSkillDir(skill: OptionalSkill, plan: Pick<InstallPlan, 'scope' | 'root'>): string {
  return path.join(plan.root, ...UNIVERSAL_PROJECT_DIR.split('/'), skill.dirName);
}

export function readStamp(dir: string): SkillStamp | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, SKILL_STAMP), 'utf-8')) as SkillStamp;
  } catch {
    return null;
  }
}

/** Which agents get a folder of their own, and which read the canonical
 *  one as is. */
export function resolveAgentFolders(plan: InstallPlan): { readers: string[]; folders: { dir: string; agents: string[] }[] } {
  const explicit = plan.agents.length > 0;
  const chosen = SKILL_AGENT_TARGETS.filter(agent => {
    if (explicit) return plan.agents.includes(agent.id);
    if (plan.scope === 'global') {
      // The agents this machine has: the folder that holds their skills
      // folder exists (~/.claude, ~/.config/goose, ~/.codeium/windsurf).
      return fs.existsSync(path.join(plan.root, path.dirname(agent.homeDir)));
    }
    // Project defaults: the shared folder's readers and Claude Code always;
    // the others only when the project already uses them.
    return agent.projectMarker === null || fs.existsSync(path.join(plan.root, agent.projectMarker));
  });

  const readers: string[] = [];
  const byDir = new Map<string, string[]>();
  for (const agent of chosen) {
    const dir = plan.scope === 'project' ? agent.projectDir : agent.homeDir;
    if (dir === UNIVERSAL_PROJECT_DIR) { readers.push(agent.name); continue; }
    byDir.set(dir, [...(byDir.get(dir) ?? []), agent.name]);
  }
  return { readers, folders: [...byDir].map(([dir, agents]) => ({ dir, agents })) };
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === SKILL_STAMP) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function removePath(target: string): void {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  } catch { /* not there */ }
}

/** A folder link from `linkPath` to `target`: a relative symlink, else a
 *  Windows junction, else a plain copy. */
function linkDir(target: string, linkPath: string): 'symlink' | 'junction' | 'copy' {
  removePath(linkPath);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath, 'dir');
    return 'symlink';
  } catch { /* e.g. Windows without developer mode */ }
  try {
    fs.symlinkSync(target, linkPath, 'junction');
    return 'junction';
  } catch { /* not Windows, or junctions refused */ }
  copyDir(target, linkPath);
  return 'copy';
}

/** Copies the skill to its canonical folder, links each agent folder to
 *  it, and stamps what was installed. Replaces an earlier install of the
 *  same skill; never touches other skills. */
export function installSkill(skill: OptionalSkill, source: SkillSource, plan: InstallPlan, cliVersion: string): InstallResult {
  const canonical = canonicalSkillDir(skill, plan);
  const previous = readStamp(canonical);
  // An agent folder this skill linked before and does not link now goes.
  const { readers, folders } = resolveAgentFolders(plan);
  const nextPaths = new Set(folders.map(f => `${f.dir}/${skill.dirName}`));
  for (const link of previous?.links ?? []) {
    if (!nextPaths.has(toPosix(link.path))) removePath(fromStamp(plan.root, link.path));
  }

  removePath(canonical);
  copyDir(source.dir, canonical);

  const links: SkillStamp['links'] = folders.map(folder => {
    const rel = `${folder.dir}/${skill.dirName}`;
    return { path: rel, kind: linkDir(canonical, fromStamp(plan.root, rel)), agents: folder.agents };
  });

  const stamp: SkillStamp = {
    skill: skill.name,
    package: skill.packageName,
    version: source.version,
    source: source.kind,
    scope: plan.scope,
    links,
    installedBy: `@withone/cli@${cliVersion}`,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(canonical, SKILL_STAMP), JSON.stringify(stamp, null, 2) + '\n');

  return { skill, version: source.version, source: source.kind, origin: source.origin, scope: plan.scope, root: plan.root, canonical, readers, links };
}

/** Removes the canonical folder and every agent folder the stamp names.
 *  Returns false when the skill is not installed in this scope. */
export function removeSkill(skill: OptionalSkill, plan: Pick<InstallPlan, 'scope' | 'root'>): { removed: boolean; paths: string[] } {
  const canonical = canonicalSkillDir(skill, plan);
  const stamp = readStamp(canonical);
  if (!stamp && !fs.existsSync(path.join(canonical, 'SKILL.md'))) return { removed: false, paths: [] };
  const paths: string[] = [];
  for (const link of stamp?.links ?? []) {
    const full = fromStamp(plan.root, link.path);
    if (fs.existsSync(full) || isDanglingLink(full)) { removePath(full); paths.push(full); }
  }
  removePath(canonical);
  paths.push(canonical);
  return { removed: true, paths };
}

/** Stamps keep paths with forward slashes, so a stamp committed on one OS
 *  reads the same on another. */
function toPosix(p: string): string {
  return p.split('\\').join('/');
}

function fromStamp(root: string, rel: string): string {
  return path.join(root, ...toPosix(rel).split('/'));
}

function isDanglingLink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export interface InstalledSkillInfo {
  scope: 'project' | 'global';
  root: string;
  canonical: string;
  version: string | null;
  source: SkillStamp['source'] | null;
  links: SkillStamp['links'];
}

export function installedSkill(skill: OptionalSkill, plan: Pick<InstallPlan, 'scope' | 'root'>): InstalledSkillInfo | null {
  const canonical = canonicalSkillDir(skill, plan);
  if (!fs.existsSync(path.join(canonical, 'SKILL.md'))) return null;
  const stamp = readStamp(canonical);
  return { scope: plan.scope, root: plan.root, canonical, version: stamp?.version ?? null, source: stamp?.source ?? null, links: stamp?.links ?? [] };
}

export function globalRoot(): string {
  return homeDir();
}

// ── Keeping project installs fresh ─────────────────────────────────────

export interface RefreshResult {
  skill: string;
  from: string;
  to: string;
  root: string;
}

/**
 * For each optional skill installed in the project around `cwd` from the
 * project's own package: when that package's installed version moved,
 * re-copy the skill so the agent reads the docs for the code it calls.
 * Local files only; a skill installed from the registry is left to
 * `one skills update`. Cheap when nothing changed: a stamp read and a
 * manifest read per skill.
 */
export function refreshProjectSkills(cwd: string, cliVersion: string): RefreshResult[] {
  const root = findProjectRoot(cwd);
  if (!root || path.resolve(root) === path.resolve(homeDir())) return [];
  const results: RefreshResult[] = [];
  for (const skill of OPTIONAL_SKILLS) {
    const canonical = canonicalSkillDir(skill, { scope: 'project', root });
    const stamp = readStamp(canonical);
    if (!stamp || stamp.scope !== 'project' || stamp.source !== 'project') continue;
    const installed = findInstalledPackage(root, skill.packageName);
    if (!installed || installed.version === stamp.version) continue;
    let source: SkillSource | null;
    try { source = projectSkillSource(skill, root); } catch { continue; }
    if (!source) continue;
    // Same agents as before: the ones the stamp names.
    const agents = SKILL_AGENT_TARGETS
      .filter(a => stamp.links.some(l => l.agents.includes(a.name)) || a.projectDir === UNIVERSAL_PROJECT_DIR)
      .map(a => a.id);
    installSkill(skill, source, { scope: 'project', root, agents }, cliVersion);
    results.push({ skill: skill.name, from: stamp.version, to: source.version, root });
  }
  return results;
}

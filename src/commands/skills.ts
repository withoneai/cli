/**
 * `one skills` — optional skills a project adds on request, such as the
 * One Connect skill. The One skill itself stays with `one init` and
 * `one config skills`; nothing here changes how that one is installed or
 * synced. See lib/project-skills.ts for the four steps.
 */

import path from 'node:path';
import pc from 'picocolors';
import { getCurrentVersion } from './update.js';
import { isAgentMode, json, error } from '../lib/output.js';
import { isSkillInstalled as isOneSkillInstalled, readInstalledSkillVersion } from '../lib/skill-sync.js';
import {
  OPTIONAL_SKILLS,
  SKILL_AGENT_TARGETS,
  SkillSourceError,
  findAgentTarget,
  findInstalledPackage,
  findOptionalSkill,
  findProjectRoot,
  globalRoot,
  installSkill,
  installedSkill,
  projectSkillSource,
  registrySkillSource,
  removeSkill,
  type InstallPlan,
  type InstallResult,
  type OptionalSkill,
  type SkillSource,
} from '../lib/project-skills.js';
import { homeDir } from '../lib/home.js';

export interface SkillsScopeOptions {
  global?: boolean;
  agents?: string;
}

function requireSkill(name: string): OptionalSkill {
  const skill = findOptionalSkill(name);
  if (!skill) {
    const known = OPTIONAL_SKILLS.map(s => s.name).join(', ');
    error(`Unknown skill "${name}". Available: ${known}. The One skill itself is installed by \`one init\`.`);
  }
  return skill;
}

function parseAgents(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const id of ids) {
    if (!findAgentTarget(id)) {
      error(`Unknown agent "${id}". Use: ${SKILL_AGENT_TARGETS.map(a => a.id).join(', ')}.`);
    }
  }
  return ids;
}

/** Where this command installs: the project around the working directory,
 *  or the home folder with --global. */
function resolvePlan(options: SkillsScopeOptions): InstallPlan {
  const agents = parseAgents(options.agents);
  if (options.global) return { scope: 'global', root: globalRoot(), agents };
  const root = findProjectRoot(process.cwd());
  if (!root || path.resolve(root) === path.resolve(homeDir())) {
    error('No project here: run this inside your app (a folder with package.json or .git), or pass --global.');
  }
  return { scope: 'project', root, agents };
}

/** The project's own package first; the latest published one only when
 *  the project does not have it (or for a global install without one). */
async function resolveSource(skill: OptionalSkill, plan: InstallPlan): Promise<SkillSource> {
  try {
    const local = projectSkillSource(skill, plan.scope === 'project' ? plan.root : process.cwd());
    if (local) return local;
    return await registrySkillSource(skill);
  } catch (err) {
    if (err instanceof SkillSourceError) error(err.message);
    throw err;
  }
}

function display(p: string, root: string): string {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

function report(command: string, result: InstallResult, packageInProject: boolean): void {
  const where = (p: string) => display(p, result.root);
  if (isAgentMode()) {
    json({
      command,
      skill: result.skill.name,
      name: result.skill.dirName,
      version: result.version,
      source: { kind: result.source, from: result.origin },
      scope: result.scope,
      root: result.root,
      installedTo: [
        { path: result.canonical, kind: 'folder', agents: result.readers },
        ...result.links.map(l => ({ path: path.join(result.root, ...l.path.split('/')), kind: l.kind, agents: l.agents })),
      ],
      next: nextSteps(result, packageInProject),
    });
    return;
  }

  const scopeLabel = result.scope === 'project' ? 'this project' : 'every project on this machine';
  console.log();
  console.log(`  ${pc.green('✓')} ${pc.bold(`${result.skill.title} skill ${result.version}`)} installed for ${scopeLabel}`);
  console.log();
  const from = result.source === 'project'
    ? `${where(result.origin)} ${pc.dim('(the version your code uses)')}`
    : `npm ${pc.dim(result.scope === 'project'
      ? `(latest ${result.skill.packageName}; not installed in this project yet)`
      : `(latest ${result.skill.packageName})`)}`;
  console.log(`  ${pc.dim('From')}  ${from}`);
  const rows = [
    { path: where(result.canonical), agents: result.readers },
    ...result.links.map(l => ({ path: `${l.path}${l.kind === 'copy' ? pc.dim(' (copy)') : ''}`, agents: l.agents })),
  ];
  rows.forEach((row, i) => {
    const agents = row.agents.length ? pc.dim(row.agents.join(', ')) : pc.dim('shared copy the links point to');
    console.log(`  ${pc.dim(i === 0 ? 'To  ' : '    ')}  ${row.path}  ${agents}`);
  });
  console.log();
  console.log(`  ${pc.bold('Next')}`);
  nextSteps(result, packageInProject).forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  console.log();
}

function nextSteps(result: InstallResult, packageInProject: boolean): string[] {
  const steps: string[] = [];
  if (result.scope === 'project' && !packageInProject) steps.push(`Install the SDK: npm install ${result.skill.packageName}`);
  steps.push(`Ask your agent: "Add ${result.skill.title} to this app." The skill tells it every step.`);
  steps.push('Set the secrets it names in your server environment yourself; never paste them into a chat.');
  if (result.scope === 'project') {
    const folders = [`${UNIVERSAL_DIR}/${result.skill.dirName}`, ...result.links.map(l => l.path)];
    steps.push(`Commit ${folders.join(' and ')} so your team's agents share it. Any \`one\` command here refreshes it when ${result.skill.packageName} is upgraded.`);
  } else {
    steps.push(`Refresh it after a new ${result.skill.packageName} release: one skills update ${result.skill.name} --global`);
  }
  return steps;
}

const UNIVERSAL_DIR = '.agents/skills';

export async function skillsAddCommand(name: string, options: SkillsScopeOptions): Promise<void> {
  const skill = requireSkill(name);
  const plan = resolvePlan(options);
  const source = await resolveSource(skill, plan);
  try {
    const result = installSkill(skill, source, plan, getCurrentVersion());
    const packageInProject = plan.scope === 'project' && findInstalledPackage(plan.root, skill.packageName) !== null;
    report('skills add', result, packageInProject);
  } finally {
    source.cleanup();
  }
}

export async function skillsUpdateCommand(name: string | undefined, options: SkillsScopeOptions): Promise<void> {
  const skills = name ? [requireSkill(name)] : OPTIONAL_SKILLS;
  const plan = resolvePlan(options);
  const updated: InstallResult[] = [];
  const skipped: string[] = [];
  for (const skill of skills) {
    const current = installedSkill(skill, plan);
    if (!current) { skipped.push(skill.name); continue; }
    // Keep the agent folders it has unless --agents says otherwise.
    const agents = plan.agents.length
      ? plan.agents
      : SKILL_AGENT_TARGETS.filter(a => current.links.some(l => l.agents.includes(a.name)) || (plan.scope === 'project' && a.projectDir === UNIVERSAL_DIR)).map(a => a.id);
    const source = await resolveSource(skill, plan);
    try {
      updated.push(installSkill(skill, source, { ...plan, agents }, getCurrentVersion()));
    } finally {
      source.cleanup();
    }
  }
  if (name && updated.length === 0) error(`${skills[0].title} skill is not installed here. Add it: one skills add ${skills[0].name}${plan.scope === 'global' ? ' --global' : ''}`);

  if (isAgentMode()) {
    json({
      command: 'skills update',
      scope: plan.scope,
      updated: updated.map(r => ({ skill: r.skill.name, version: r.version, source: r.source, path: r.canonical })),
      notInstalled: skipped,
    });
    return;
  }
  if (updated.length === 0) {
    console.log('No optional skills are installed here. See: one skills list');
    return;
  }
  for (const r of updated) console.log(`  ${pc.green('✓')} ${r.skill.title} skill ${r.version} ${pc.dim(display(r.canonical, r.root))}`);
}

export async function skillsRemoveCommand(name: string, options: SkillsScopeOptions): Promise<void> {
  const skill = requireSkill(name);
  const plan = resolvePlan(options);
  const result = removeSkill(skill, plan);
  if (isAgentMode()) {
    json({ command: 'skills remove', skill: skill.name, scope: plan.scope, removed: result.removed, paths: result.paths });
    return;
  }
  if (!result.removed) {
    console.log(`${skill.title} skill is not installed ${plan.scope === 'global' ? 'globally' : 'in this project'}.`);
    return;
  }
  console.log(`  ${pc.green('✓')} Removed the ${skill.title} skill`);
  for (const p of result.paths) console.log(`    ${pc.dim(display(p, plan.root))}`);
}

export async function skillsListCommand(): Promise<void> {
  const projectRoot = findProjectRoot(process.cwd());
  const inProject = projectRoot && path.resolve(projectRoot) !== path.resolve(homeDir()) ? projectRoot : null;

  const optional = OPTIONAL_SKILLS.map(skill => {
    const project = inProject ? installedSkill(skill, { scope: 'project', root: inProject }) : null;
    const global = installedSkill(skill, { scope: 'global', root: globalRoot() });
    const pkg = inProject ? findInstalledPackage(inProject, skill.packageName) : null;
    return {
      skill: skill.name,
      name: skill.dirName,
      title: skill.title,
      description: skill.description,
      package: skill.packageName,
      packageInProject: pkg?.version ?? null,
      project: project ? { version: project.version, path: project.canonical, upToDate: !pkg || project.version === pkg.version } : null,
      global: global ? { version: global.version, path: global.canonical } : null,
    };
  });
  const oneSkill = {
    skill: 'one',
    title: 'One CLI',
    managedBy: 'one init',
    installed: isOneSkillInstalled(),
    version: readInstalledSkillVersion(),
  };

  if (isAgentMode()) {
    json({ command: 'skills list', project: inProject, skills: [oneSkill, ...optional] });
    return;
  }

  console.log();
  console.log(`  ${pc.bold('one')}      ${oneSkill.installed ? pc.green(`installed ${oneSkill.version ?? ''}`.trim()) : pc.yellow('not installed')}  ${pc.dim('managed by one init')}`);
  for (const s of optional) {
    const state = s.project
      ? pc.green(`project ${s.project.version ?? ''}`.trim()) + (s.project.upToDate ? '' : pc.yellow(` (package is ${s.packageInProject}: run one skills update ${s.skill})`))
      : s.global
        ? pc.green(`global ${s.global.version ?? ''}`.trim())
        : pc.dim(`not installed — one skills add ${s.skill}`);
    console.log(`  ${pc.bold(s.skill.padEnd(8))} ${state}`);
    console.log(`  ${' '.repeat(8)} ${pc.dim(s.description)}`);
  }
  console.log();
}

/**
 * Skill bundle resolver for agentic pipeline stages.
 *
 * Why this exists
 * ---------------
 * Each agentic stage adapter embeds the literal markdown of a
 * superpowers skill (`brainstorming`, `writing-plans`, etc.) in its
 * agent-loop prompt so the agent operates under the skill's discipline
 * (ask one question at a time, propose 2-3 alternatives; bite-sized
 * tasks with exact paths; etc.).
 *
 * The resolver tries the operator's local plugin cache first
 * (`~/.claude/plugins/cache/claude-plugins-official/superpowers/<version>/skills/<bundle>/SKILL.md`)
 * so updates flow through automatically when the operator upgrades the
 * plugin. When the plugin cache is absent (CI environment, deployment
 * without the operator's plugin), it falls back to the vendored copy
 * under `examples/planning-stages/skills/<bundle>.md`.
 *
 * The vendored copy is the substrate-canonical content; the operator's
 * plugin cache provides forward-compat access to upstream updates
 * without forcing a vendoring refresh on every minor upstream change.
 *
 * Substrate purity
 * ----------------
 * Lives under examples/planning-stages/lib/ alongside the agent-loop
 * helper. Pure I/O orchestration; no atom writes, no LLM calls, no
 * canon reads. Indie deployments inherit the vendored bundle; org
 * deployments swap in their own skill markdown by editing the vendored
 * files (no code change needed).
 *
 * Threat model
 * ------------
 * - Path traversal: skill names are matched against a small allow-list
 *   inside this module so a caller-supplied skill name cannot resolve
 *   into an arbitrary file on disk. Adding a new skill is a code edit
 *   (the allow-list expands), not a runtime config knob.
 * - Plugin-cache version: the resolver reads any version that lives
 *   under the cache directory; operators that pin a version manage the
 *   plugin cache itself.
 * - Caching: the resolver caches resolved bundles in-process so a
 *   stage that runs many times in one session pays the disk read once.
 *   Cache invalidation on plugin update happens at process boundary;
 *   restart the runner after an upgrade to refresh.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Allow-listed skill names. Adding a new skill is a code edit. */
export const SUPPORTED_SKILLS = [
  'brainstorming',
  'writing-plans',
  'requesting-code-review',
  'subagent-driven-development',
  'test-driven-development',
] as const;
export type SupportedSkillName = (typeof SUPPORTED_SKILLS)[number];

/** Plugin-cache root the resolver searches first. */
const PLUGIN_CACHE_RELATIVE = [
  '.claude',
  'plugins',
  'cache',
  'claude-plugins-official',
  'superpowers',
];

/** Vendored fallback under examples/planning-stages/skills/. */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VENDORED_DIR = resolve(__dirname, '..', 'skills');

const cache = new Map<SupportedSkillName, string>();

function isSupportedSkill(name: string): name is SupportedSkillName {
  return (SUPPORTED_SKILLS as ReadonlyArray<string>).includes(name);
}

async function readPluginCacheBundle(
  homeDir: string,
  skillName: SupportedSkillName,
): Promise<string | null> {
  const cacheRoot = join(homeDir, ...PLUGIN_CACHE_RELATIVE);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    // The DirentCallback overloads vary across @types/node versions; cast
    // through the structural shape we actually use below so this module
    // does not depend on the latest Dirent generic refinement.
    entries = (await fs.readdir(cacheRoot, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
  } catch {
    return null;
  }
  // Find the highest-versioned subdirectory that has the skill markdown.
  const versions = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = join(
      cacheRoot,
      version,
      'skills',
      skillName,
      'SKILL.md',
    );
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

async function readVendoredBundle(
  skillName: SupportedSkillName,
): Promise<string | null> {
  const candidate = join(VENDORED_DIR, `${skillName}.md`);
  try {
    return await fs.readFile(candidate, 'utf8');
  } catch {
    return null;
  }
}

export interface ResolveSkillBundleOptions {
  /** Override $HOME for tests; defaults to process.env.HOME ?? USERPROFILE. */
  readonly homeDir?: string;
  /** Skip the plugin-cache lookup (tests assert vendored fallback). */
  readonly skipPluginCache?: boolean;
}

export class SkillBundleNotFoundError extends Error {
  constructor(
    skillName: string,
    public readonly searched: ReadonlyArray<string>,
  ) {
    super(
      `skill bundle '${skillName}' not found in plugin cache or vendored copy. `
      + `Searched: ${searched.join(', ')}`,
    );
    this.name = 'SkillBundleNotFoundError';
  }
}

/**
 * Resolve a skill bundle to its full markdown content. Tries the
 * plugin cache first, then falls back to the vendored copy. Throws
 * `SkillBundleNotFoundError` when neither path resolves; callers MUST
 * fail-loud rather than silently substitute an empty prompt.
 */
export async function resolveSkillBundle(
  skillName: string,
  options: ResolveSkillBundleOptions = {},
): Promise<string> {
  if (!isSupportedSkill(skillName)) {
    throw new Error(
      `resolveSkillBundle: unsupported skill name '${skillName}'. `
      + `Supported: ${SUPPORTED_SKILLS.join(', ')}.`,
    );
  }
  const cached = cache.get(skillName);
  if (cached !== undefined) return cached;

  const searched: string[] = [];
  if (!options.skipPluginCache) {
    const homeDir =
      options.homeDir
      ?? process.env.HOME
      ?? process.env.USERPROFILE
      ?? '';
    if (homeDir !== '') {
      const fromPlugin = await readPluginCacheBundle(homeDir, skillName);
      searched.push(`plugin-cache:${homeDir}`);
      if (fromPlugin !== null) {
        cache.set(skillName, fromPlugin);
        return fromPlugin;
      }
    }
  }
  const fromVendored = await readVendoredBundle(skillName);
  searched.push(`vendored:${VENDORED_DIR}`);
  if (fromVendored !== null) {
    cache.set(skillName, fromVendored);
    return fromVendored;
  }
  throw new SkillBundleNotFoundError(skillName, searched);
}

/** Test-only hook: clears the in-process resolver cache. */
export function _resetSkillBundleCacheForTests(): void {
  cache.clear();
}

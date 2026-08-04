import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { RepoAgentDto } from '@agentforge/core';
import { parseGithubRepo } from '../../scm/domain/scm';
import { SECRET_REPOSITORY, type SecretRepository } from '../domain/repositories';
import { SecretBoxService } from '../../../shared/crypto/secret-box';
import { ProjectsService } from './projects.service';

const REGISTRY_PATH = 'config/agents.json';
const KNOWN_META_KEYS = new Set(['role', 'command', 'prompt', 'provider', 'isolation', 'tools']);

type RegistryFile = {
  agents?: Record<string, RegistryAgentDef>;
  specialists?: Record<string, { prompt?: string; provider?: string }>;
  commands?: Record<string, string>;
};

type RegistryAgentDef = {
  role?: string;
  command?: string;
  prompt?: string;
  provider?: string;
  isolation?: string;
  tools?: string[];
  [key: string]: unknown;
};

/**
 * Reads the in-repo agent registry (Lava-style `config/agents.json`) and the
 * linked prompt files, returning full descriptions suitable for driving a run.
 *
 * API has no workspaces volume (§11.1), so we fetch via the GitHub Contents API
 * (optional project `GITHUB_TOKEN` for private repos / higher rate limits).
 */
@Injectable()
export class RepoAgentsService {
  private readonly logger = new Logger(RepoAgentsService.name);

  constructor(
    private readonly projects: ProjectsService,
    @Inject(SECRET_REPOSITORY) private readonly secrets: SecretRepository,
    private readonly secretBox: SecretBoxService,
  ) {}

  async list(ownerId: string, projectId: string): Promise<RepoAgentDto[]> {
    const { ref, fetchText } = await this.openRepo(ownerId, projectId);
    const registry = await this.loadRegistry(fetchText, ref);
    const out: RepoAgentDto[] = [];

    for (const [name, def] of Object.entries(registry.agents ?? {})) {
      out.push(await this.toAgentDto(name, 'agent', def, fetchText, ref));
    }
    for (const [name, def] of Object.entries(registry.specialists ?? {})) {
      out.push(
        await this.toAgentDto(
          name,
          'specialist',
          {
            // role filled from markdown frontmatter `description` when present
            prompt: def.prompt,
            provider: def.provider,
          },
          fetchText,
          ref,
        ),
      );
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(ownerId: string, projectId: string, name: string): Promise<RepoAgentDto> {
    const { ref, fetchText } = await this.openRepo(ownerId, projectId);
    const registry = await this.loadRegistry(fetchText, ref);

    const mapped = registry.commands?.[name] ?? name;
    const agentDef = registry.agents?.[mapped];
    if (agentDef) {
      return this.toAgentDto(mapped, 'agent', agentDef, fetchText, ref);
    }
    const specialist = registry.specialists?.[mapped] ?? registry.specialists?.[name];
    if (specialist) {
      return this.toAgentDto(
        mapped === name ? name : mapped,
        'specialist',
        {
          prompt: specialist.prompt,
          provider: specialist.provider,
        },
        fetchText,
        ref,
      );
    }
    throw new NotFoundException(`repo agent "${name}" not found in ${REGISTRY_PATH}`);
  }

  private async openRepo(
    ownerId: string,
    projectId: string,
  ): Promise<{
    ref: string;
    fetchText: (path: string) => Promise<string | null>;
  }> {
    const project = await this.projects.getOwned(ownerId, projectId);
    const github = parseGithubRepo(project.repoUrl);
    if (!github) {
      throw new BadRequestException('repo agents are only supported for GitHub project URLs (https://github.com/owner/repo)');
    }

    const apiBase = ((project.settings as { githubApiUrl?: string } | undefined)?.githubApiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    const ref = project.defaultBranch || 'HEAD';
    const token = await this.githubToken(projectId);

    const fetchText = async (filePath: string): Promise<string | null> => {
      const url = `${apiBase}/repos/${github.owner}/${github.repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
      const headers: Record<string, string> = {
        accept: 'application/vnd.github.raw+json',
        'user-agent': 'agentforge',
      };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(url, { headers });
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        this.logger.warn(`github contents ${filePath} → ${res.status}: ${body}`);
        throw new BadRequestException(`failed to read ${filePath} from GitHub (${res.status})`);
      }
      return res.text();
    };

    return { ref, fetchText };
  }

  private async loadRegistry(fetchText: (path: string) => Promise<string | null>, _ref: string): Promise<RegistryFile> {
    const raw = await fetchText(REGISTRY_PATH);
    if (raw == null) {
      throw new NotFoundException(`${REGISTRY_PATH} not found on the project's default branch`);
    }
    try {
      return JSON.parse(raw) as RegistryFile;
    } catch {
      throw new BadRequestException(`${REGISTRY_PATH} is not valid JSON`);
    }
  }

  private async toAgentDto(
    name: string,
    kind: 'agent' | 'specialist',
    def: RegistryAgentDef,
    fetchText: (path: string) => Promise<string | null>,
    _ref: string,
  ): Promise<RepoAgentDto> {
    const promptPath = typeof def.prompt === 'string' ? def.prompt : null;
    let description = '';
    let role = typeof def.role === 'string' ? def.role : '';

    if (promptPath) {
      const file = await fetchText(promptPath);
      if (file != null) {
        const parsed = parseMarkdownAgent(file);
        description = parsed.body;
        // Specialists put the short blurb in frontmatter `description`.
        if (parsed.frontmatterDescription) {
          if (!role || kind === 'specialist') role = parsed.frontmatterDescription;
        }
        if (!role && parsed.frontmatterName) role = parsed.frontmatterName;
      } else {
        this.logger.warn(`prompt missing for repo agent ${name}: ${promptPath}`);
      }
    }

    if (!role) role = kind === 'specialist' ? `Specialist: ${name}` : name;
    if (!description) description = role;

    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(def)) {
      if (!KNOWN_META_KEYS.has(key) && value !== undefined) meta[key] = value;
    }

    return {
      name,
      kind,
      role,
      description,
      promptPath,
      ...(typeof def.command === 'string' ? { command: def.command } : {}),
      ...(typeof def.provider === 'string' ? { provider: def.provider } : {}),
      ...(typeof def.isolation === 'string' ? { isolation: def.isolation } : {}),
      ...(Array.isArray(def.tools) ? { tools: def.tools.filter((t): t is string => typeof t === 'string') } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
  }

  private async githubToken(projectId: string): Promise<string | null> {
    const row = await this.secrets.find(projectId, 'GITHUB_TOKEN');
    if (!row) return null;
    try {
      return this.secretBox.decrypt(row.ciphertext);
    } catch (error) {
      this.logger.warn(`could not decrypt GITHUB_TOKEN for project ${projectId}: ${String(error).slice(0, 120)}`);
      return null;
    }
  }
}

/** Split optional YAML frontmatter from a markdown agent/specialist file. */
function parseMarkdownAgent(text: string): {
  body: string;
  frontmatterName?: string;
  frontmatterDescription?: string;
} {
  if (!text.startsWith('---')) return { body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { body: text };
  const fm = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\s*\n/, '');
  let frontmatterName: string | undefined;
  let frontmatterDescription: string | undefined;
  for (const line of fm.split('\n')) {
    const name = /^name:\s*(.+)$/.exec(line);
    if (name) frontmatterName = name[1]!.trim().replace(/^["']|["']$/g, '');
    const desc = /^description:\s*(.+)$/.exec(line);
    if (desc) frontmatterDescription = desc[1]!.trim().replace(/^["']|["']$/g, '');
  }
  // Multi-line description: `description: |` blocks — take rest of frontmatter after key.
  const block = /^description:\s*[|>]?\s*\n([\s\S]+)/m.exec(fm);
  if (block && !frontmatterDescription) {
    frontmatterDescription = block[1]!
      .split('\n')
      .map((l) => l.replace(/^\s{2}/, ''))
      .join('\n')
      .trim();
  }
  return { body: body.trimEnd() + '\n', frontmatterName, frontmatterDescription };
}

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { getResonantConfig, PROJECT_ROOT, reloadConfig } from '../config.js';

type StatusError = Error & { statusCode?: number };

function createStatusError(message: string, statusCode: number): StatusError {
  const error = new Error(message) as StatusError;
  error.statusCode = statusCode;
  return error;
}

export function findConfigPath(): string | null {
  for (const name of ['resonant.yaml', 'resonant.yml']) {
    const projectPath = join(PROJECT_ROOT, name);
    if (existsSync(projectPath)) return projectPath;
  }

  for (const name of ['resonant.yaml', 'resonant.yml']) {
    const cwdPath = resolve(name);
    if (existsSync(cwdPath)) return cwdPath;
  }

  return null;
}

export function getClaudeMdData() {
  const claudePath = join(PROJECT_ROOT, 'CLAUDE.md');
  const examplePath = join(PROJECT_ROOT, 'examples', 'CLAUDE.md');
  const templatePath = join(PROJECT_ROOT, 'examples', 'CLAUDE.md.template');

  return {
    content: existsSync(claudePath) ? readFileSync(claudePath, 'utf-8') : '',
    example: existsSync(examplePath) ? readFileSync(examplePath, 'utf-8') : '',
    template: existsSync(templatePath) ? readFileSync(templatePath, 'utf-8') : '',
  };
}

export function saveClaudeMd(content: string): void {
  writeFileSync(join(PROJECT_ROOT, 'CLAUDE.md'), content, 'utf-8');
}

export function getMcpJsonData() {
  const mcpPath = join(PROJECT_ROOT, '.mcp.json');
  const examplePath = join(PROJECT_ROOT, 'examples', '.mcp.json');

  return {
    content: existsSync(mcpPath) ? readFileSync(mcpPath, 'utf-8') : '{"mcpServers":{}}',
    example: existsSync(examplePath) ? readFileSync(examplePath, 'utf-8') : '',
  };
}

export function validateAndSaveMcpJson(content: string): void {
  const parsed = JSON.parse(content);
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    throw createStatusError('JSON must contain a "mcpServers" object', 400);
  }

  writeFileSync(join(PROJECT_ROOT, '.mcp.json'), JSON.stringify(parsed, null, 2), 'utf-8');
}

export function readPreferences() {
  const configPath = findConfigPath();
  if (!configPath) {
    throw createStatusError('No config file found. Run the setup wizard first.', 404);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = (yaml.load(raw) as Record<string, unknown>) || {};
  const config = getResonantConfig();

  return {
    identity: {
      companion_name: config.identity.companion_name,
      user_name: config.identity.user_name,
      timezone: config.identity.timezone,
    },
    agent: {
      model: config.agent.model,
      model_autonomous: config.agent.model_autonomous,
      thinking_effort: config.agent.thinking_effort || 'max',
    },
    orchestrator: {
      enabled: (parsed as any)?.orchestrator?.enabled ?? config.orchestrator.enabled,
    },
    voice: {
      enabled: (parsed as any)?.voice?.enabled ?? config.voice.enabled,
    },
    discord: {
      enabled: (parsed as any)?.discord?.enabled ?? config.discord.enabled,
    },
    telegram: {
      enabled: (parsed as any)?.telegram?.enabled ?? config.telegram.enabled,
    },
    auth: {
      has_password: !!config.auth.password,
    },
  };
}

export function savePreferences(updates: Record<string, any>): void {
  const configPath = findConfigPath();
  if (!configPath) {
    throw createStatusError('No config file found', 404);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = (yaml.load(raw) as Record<string, any>) || {};

  if (updates.identity) {
    if (!parsed.identity) parsed.identity = {};
    if (updates.identity.companion_name !== undefined) parsed.identity.companion_name = updates.identity.companion_name;
    if (updates.identity.user_name !== undefined) parsed.identity.user_name = updates.identity.user_name;
    if (updates.identity.timezone !== undefined) parsed.identity.timezone = updates.identity.timezone;
  }

  if (updates.agent) {
    if (!parsed.agent) parsed.agent = {};
    if (updates.agent.model !== undefined) parsed.agent.model = updates.agent.model;
    if (updates.agent.model_autonomous !== undefined) parsed.agent.model_autonomous = updates.agent.model_autonomous;
    if (updates.agent.thinking_effort !== undefined) parsed.agent.thinking_effort = updates.agent.thinking_effort;
  }

  if (updates.orchestrator) {
    if (!parsed.orchestrator) parsed.orchestrator = {};
    if (updates.orchestrator.enabled !== undefined) parsed.orchestrator.enabled = updates.orchestrator.enabled;
  }

  if (updates.voice) {
    if (!parsed.voice) parsed.voice = {};
    if (updates.voice.enabled !== undefined) parsed.voice.enabled = updates.voice.enabled;
  }

  if (updates.discord) {
    if (!parsed.discord) parsed.discord = {};
    if (updates.discord.enabled !== undefined) parsed.discord.enabled = updates.discord.enabled;
  }

  if (updates.telegram) {
    if (!parsed.telegram) parsed.telegram = {};
    if (updates.telegram.enabled !== undefined) parsed.telegram.enabled = updates.telegram.enabled;
  }

  if (updates.auth) {
    if (!parsed.auth) parsed.auth = {};
    if (updates.auth.password !== undefined) parsed.auth.password = updates.auth.password;
  }

  const newYaml = yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true });
  writeFileSync(configPath, newYaml, 'utf-8');
}

export function getSetupStatus() {
  const configExists = existsSync(join(PROJECT_ROOT, 'resonant.yaml'));
  const claudeMdExists = existsSync(join(PROJECT_ROOT, 'CLAUDE.md'));
  const mcpJsonExists = existsSync(join(PROJECT_ROOT, '.mcp.json'));

  return {
    needsSetup: !configExists,
    hasClaudeMd: claudeMdExists,
    hasMcpJson: mcpJsonExists,
  };
}

export function completeFirstRunSetup(input: {
  companionName?: string;
  userName?: string;
  timezone?: string;
  password?: string;
  personality?: string;
}): void {
  const configPath = join(PROJECT_ROOT, 'resonant.yaml');
  if (existsSync(configPath)) {
    throw createStatusError('Setup already completed', 409);
  }

  const {
    companionName = 'Echo',
    userName = 'User',
    timezone = 'UTC',
    password = '',
    personality = '',
  } = input;

  const yamlConfig = {
    identity: {
      companion_name: companionName,
      user_name: userName,
      timezone,
    },
    server: { port: 3002, host: '127.0.0.1' },
    auth: { password },
    agent: { model: 'claude-sonnet-4-6' },
    orchestrator: { enabled: true },
    command_center: { enabled: true },
  };
  writeFileSync(configPath, yaml.dump(yamlConfig, { lineWidth: -1 }), 'utf-8');

  const claudeMdPath = join(PROJECT_ROOT, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    if (personality.trim()) {
      writeFileSync(claudeMdPath, personality, 'utf-8');
    } else {
      const examplePath = join(PROJECT_ROOT, 'examples', 'CLAUDE.md');
      if (existsSync(examplePath)) {
        copyFileSync(examplePath, claudeMdPath);
      } else {
        writeFileSync(claudeMdPath, `# ${companionName}\n\nYou are ${companionName}, a warm and genuine AI companion.\n`, 'utf-8');
      }
    }
  }

  const mcpPath = join(PROJECT_ROOT, '.mcp.json');
  if (!existsSync(mcpPath)) {
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
  }

  const promptsDir = join(PROJECT_ROOT, 'prompts');
  if (!existsSync(promptsDir)) {
    mkdirSync(promptsDir, { recursive: true });
  }

  const wakePath = join(promptsDir, 'wake.md');
  if (!existsSync(wakePath)) {
    const exampleWake = join(PROJECT_ROOT, 'examples', 'wake-prompts.md');
    if (existsSync(exampleWake)) {
      let content = readFileSync(exampleWake, 'utf-8');
      content = content.replace(/\{user_name\}/g, userName);
      writeFileSync(wakePath, content, 'utf-8');
    }
  }

  reloadConfig();
}

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRESETS = Object.freeze({
  full: Object.freeze({
    serverArgs: [],
    description: 'Full tool surface (core + file + state).'
  }),
  core: Object.freeze({
    serverArgs: ['--tool-profile', 'core'],
    description: 'Core-only tool surface for messaging and sync.'
  }),
  file: Object.freeze({
    serverArgs: ['--tool-profile', 'file'],
    description: 'Core + file transfer tools.'
  }),
  state: Object.freeze({
    serverArgs: ['--tool-profile', 'state'],
    description: 'Core + shared state tools.'
  }),
  'secure-core': Object.freeze({
    serverArgs: ['--tool-profile', 'core', '--enforce-join-token', 'true', '--require-session-mac', 'true'],
    description: 'Core profile plus join-token enforcement and session MAC requirement.'
  }),
  'secure-full': Object.freeze({
    serverArgs: ['--tool-profile', 'full', '--enforce-join-token', 'true', '--require-session-mac', 'true'],
    description: 'Full profile plus join-token enforcement and session MAC requirement.'
  })
});

function usage() {
  const presetList = Object.keys(PRESETS)
    .map((name) => `  - ${name}: ${PRESETS[name].description}`)
    .join('\n');
  const text = `
Usage:
  vdon-mcp-install [options]

Options:
  --uninstall                  Remove MCP server entries instead of installing.
  --name <name>                Server name. Default: vdo-ninja-mcp
  --server-script <path>       Path to MCP server script. Default: bundled scripts/vdo-mcp-server.js
  --node-cmd <path_or_name>    Node executable used in registered command. Default: current node
  --preset <name>              Registration preset. Default: full
  --server-arg <value>         Extra server argument (repeatable).
  --codex-only                 Only apply Codex MCP configuration.
  --claude-only                Only apply Claude MCP configuration.
  --claude-scope <scope>       Claude scope: local|user|project. Default: local
  --dry-run                    Print actions without executing.
  -h, --help                   Show this help.

Presets:
${presetList}
`;
  process.stdout.write(text.trim() + '\n');
}

function parseArgs(argv) {
  const out = {
    action: 'install',
    name: 'vdo-ninja-mcp',
    serverScript: path.resolve(__dirname, 'vdo-mcp-server.js'),
    nodeCmd: process.execPath,
    preset: 'full',
    serverArgs: [],
    codex: true,
    claude: true,
    claudeScope: 'local',
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--uninstall') {
      out.action = 'uninstall';
      continue;
    }
    if (arg === '--name') {
      out.name = argv[++i];
      continue;
    }
    if (arg === '--server-script') {
      out.serverScript = path.resolve(argv[++i]);
      continue;
    }
    if (arg === '--node-cmd') {
      out.nodeCmd = argv[++i];
      continue;
    }
    if (arg === '--preset') {
      out.preset = String(argv[++i] || '').trim().toLowerCase();
      continue;
    }
    if (arg === '--server-arg') {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--server-arg requires a value');
      }
      out.serverArgs.push(String(value));
      continue;
    }
    if (arg === '--codex-only') {
      out.claude = false;
      out.codex = true;
      continue;
    }
    if (arg === '--claude-only') {
      out.codex = false;
      out.claude = true;
      continue;
    }
    if (arg === '--claude-scope') {
      out.claudeScope = String(argv[++i] || '').trim().toLowerCase();
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!out.codex && !out.claude) {
    throw new Error('No target selected (Codex/Claude).');
  }
  if (!out.name || !String(out.name).trim()) {
    throw new Error('Server name is required.');
  }
  if (!['local', 'user', 'project'].includes(out.claudeScope)) {
    throw new Error(`Invalid --claude-scope: ${out.claudeScope}`);
  }
  if (!PRESETS[out.preset]) {
    throw new Error(`Invalid --preset: ${out.preset}`);
  }
  return out;
}

function runCommand(command, args, options = {}) {
  const cmdLabel = `${command} ${args.join(' ')}`;
  if (options.dryRun) {
    process.stdout.write(`[dry-run] ${cmdLabel}\n`);
    return { ok: true, code: 0, stdout: '', stderr: '' };
  }

  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env || process.env,
    cwd: options.cwd || process.cwd()
  });

  const code = Number.isInteger(result.status) ? result.status : 1;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (!options.quiet && stdout.trim()) process.stdout.write(stdout);
  if (!options.quiet && stderr.trim()) process.stderr.write(stderr);
  return {
    ok: code === 0,
    code,
    stdout,
    stderr
  };
}

function assertBinaryExists(name, options) {
  const check = runCommand(name, ['--version'], {
    dryRun: options.dryRun,
    quiet: true,
    env: options.env,
    cwd: options.cwd
  });
  if (!check.ok) {
    throw new Error(`Required command not found or not working: ${name}`);
  }
}

function codexServerExists(name, options) {
  if (options.dryRun) return false;
  const result = runCommand('codex', ['mcp', 'get', name, '--json'], {
    dryRun: options.dryRun,
    quiet: true,
    env: options.env,
    cwd: options.cwd
  });
  return result.ok;
}

function claudeServerExists(name, options) {
  if (options.dryRun) return false;
  const result = runCommand('claude', ['mcp', 'get', name], {
    dryRun: options.dryRun,
    quiet: true,
    env: options.env,
    cwd: options.cwd
  });
  return result.ok;
}

function installCodex(config, options) {
  process.stdout.write(`Installing Codex MCP server '${config.name}'...\n`);
  if (codexServerExists(config.name, options)) {
    runCommand('codex', ['mcp', 'remove', config.name], options);
  }
  const add = runCommand('codex', ['mcp', 'add', config.name, '--', config.nodeCmd, config.serverScript, ...config.serverArgs], options);
  if (!add.ok) throw new Error(`Failed to add Codex MCP server '${config.name}'.`);
  runCommand('codex', ['mcp', 'get', config.name, '--json'], options);
}

function uninstallCodex(config, options) {
  process.stdout.write(`Removing Codex MCP server '${config.name}'...\n`);
  if (!codexServerExists(config.name, options)) {
    process.stdout.write('Codex MCP server not found; skipping.\n');
    return;
  }
  const remove = runCommand('codex', ['mcp', 'remove', config.name], options);
  if (!remove.ok) throw new Error(`Failed to remove Codex MCP server '${config.name}'.`);
}

function installClaude(config, options) {
  process.stdout.write(`Installing Claude MCP server '${config.name}' (scope=${config.claudeScope})...\n`);
  if (claudeServerExists(config.name, options)) {
    runCommand('claude', ['mcp', 'remove', config.name], options);
  }
  const add = runCommand(
    'claude',
    ['mcp', 'add', '-s', config.claudeScope, config.name, '--', config.nodeCmd, config.serverScript, ...config.serverArgs],
    options
  );
  if (!add.ok) throw new Error(`Failed to add Claude MCP server '${config.name}'.`);
  runCommand('claude', ['mcp', 'get', config.name], options);
}

function uninstallClaude(config, options) {
  process.stdout.write(`Removing Claude MCP server '${config.name}'...\n`);
  if (!claudeServerExists(config.name, options)) {
    process.stdout.write('Claude MCP server not found; skipping.\n');
    return;
  }
  const remove = runCommand('claude', ['mcp', 'remove', config.name], options);
  if (!remove.ok) throw new Error(`Failed to remove Claude MCP server '${config.name}'.`);
}

function ensureInputs(config) {
  if (!fs.existsSync(config.serverScript)) {
    throw new Error(`Server script not found: ${config.serverScript}`);
  }
}

function applyPreset(config) {
  const preset = PRESETS[config.preset];
  const mergedServerArgs = [...preset.serverArgs, ...config.serverArgs];
  return {
    ...config,
    serverArgs: mergedServerArgs
  };
}

function main() {
  let config = parseArgs(process.argv.slice(2));
  config = applyPreset(config);
  ensureInputs(config);

  const options = {
    dryRun: config.dryRun,
    env: process.env,
    cwd: process.cwd()
  };

  process.stdout.write(`Using preset '${config.preset}' with server args: ${config.serverArgs.join(' ') || '(none)'}\n`);
  if (config.preset.startsWith('secure') && !process.env.VDON_MCP_JOIN_TOKEN_SECRET) {
    process.stdout.write('Warning: secure preset selected but VDON_MCP_JOIN_TOKEN_SECRET is not set in this shell.\n');
  }

  if (config.codex) assertBinaryExists('codex', options);
  if (config.claude) assertBinaryExists('claude', options);

  if (config.action === 'install') {
    if (config.codex) installCodex(config, options);
    if (config.claude) installClaude(config, options);
  } else {
    if (config.codex) uninstallCodex(config, options);
    if (config.claude) uninstallClaude(config, options);
  }

  process.stdout.write('\nDone.\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

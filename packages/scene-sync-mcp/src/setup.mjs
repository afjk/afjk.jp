import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'

export const defaultSessionFile = path.join(os.homedir(), '.config', 'scene-sync-mcp', 'session.json')
export const packageSpec = '@afjk/scene-sync-mcp@latest'

export function printSetupUsage() {
  console.error(`Usage:
  scene-sync-mcp setup codex [--staging] [--name <server-name>]
  scene-sync-mcp setup claude [--staging] [--print]`)
}

export function getConfig({ staging = false } = {}) {
  return {
    baseUrl: staging
      ? 'https://staging.afjk.jp/presence/api/ai'
      : 'https://afjk.jp/presence/api/ai',
    sessionFile: defaultSessionFile,
    packageSpec
  }
}

export function buildCodexAddCommand({ staging = false, name = null } = {}) {
  const config = getConfig({ staging })
  const serverName = name || (staging ? 'scene-sync-staging' : 'scene-sync')
  const args = [
    'mcp',
    'add',
    serverName,
    '--env',
    `SCENE_SYNC_BASE_URL=${config.baseUrl}`,
    '--env',
    `SCENE_SYNC_SESSION_FILE=${config.sessionFile}`,
    '--',
    'npx',
    '-y',
    config.packageSpec
  ]

  return {
    serverName,
    args,
    commandString: `codex ${args.join(' ')}`
  }
}

export function formatClaudeConfig({ staging = false } = {}) {
  const config = getConfig({ staging })
  return {
    mcpServers: {
      'scene-sync': {
        command: 'npx',
        args: ['-y', config.packageSpec],
        env: {
          SCENE_SYNC_BASE_URL: config.baseUrl,
          SCENE_SYNC_SESSION_FILE: config.sessionFile
        }
      }
    }
  }
}

export function printClaudeConfig({ staging = false } = {}) {
  process.stdout.write(`${JSON.stringify(formatClaudeConfig({ staging }), null, 2)}\n`)
}

export function resolveClaudeConfigPath() {
  const override = process.env.CLAUDE_DESKTOP_CONFIG
  if (override) return override

  const home = os.homedir()
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    default:
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
  }
}

export async function writeClaudeConfig({ staging = false } = {}) {
  const configPath = resolveClaudeConfigPath()
  const sceneSyncConfig = formatClaudeConfig({ staging }).mcpServers['scene-sync']
  let current = {}

  try {
    const existing = await fs.readFile(configPath, 'utf8')
    current = JSON.parse(existing)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Failed to read Claude Desktop config at ${configPath}: ${error.message}`)
    }
  }

  const next = {
    ...current,
    mcpServers: {
      ...(current.mcpServers || {}),
      'scene-sync': sceneSyncConfig
    }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`)

  process.stdout.write(`Updated Claude Desktop config: ${configPath}\n`)
  return configPath
}

export function runCodexSetup({ staging = false, name = null } = {}) {
  const { commandString, args } = buildCodexAddCommand({ staging, name })
  const result = spawnSync('codex', args, {
    stdio: 'inherit'
  })

  if (result.error) {
    console.error('\nFailed to run `codex mcp add` automatically.')
    console.error('Run this command manually:\n')
    console.error(commandString)
    return 1
  }

  return result.status ?? 0
}

export async function runSetupCli(args = process.argv.slice(2)) {
  const target = args[0]
  const staging = args.includes('--staging')
  const shouldPrint = args.includes('--print')
  const nameIndex = args.indexOf('--name')
  const name = nameIndex >= 0 ? args[nameIndex + 1] : null

  if (!target) {
    printSetupUsage()
    return 1
  }

  if (target === 'codex') {
    return runCodexSetup({ staging, name })
  }

  if (target === 'claude') {
    if (shouldPrint) {
      printClaudeConfig({ staging })
      return 0
    }
    await writeClaudeConfig({ staging })
    return 0
  }

  printSetupUsage()
  return 1
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isDirectExecution) {
  process.exit(await runSetupCli())
}

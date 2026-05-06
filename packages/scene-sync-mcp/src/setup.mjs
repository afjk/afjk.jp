import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

export const defaultSessionFile = path.join(os.homedir(), '.config', 'scene-sync-mcp', 'session.json')
export const packageSpec = '@afjk/scene-sync-mcp@latest'

export function printSetupUsage() {
  console.error(`Usage:
  scene-sync-mcp setup codex [--staging] [--name <server-name>]
  scene-sync-mcp setup claude [--staging]`)
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

export function runSetupCli(args = process.argv.slice(2)) {
  const target = args[0]
  const staging = args.includes('--staging')
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
    printClaudeConfig({ staging })
    return 0
  }

  printSetupUsage()
  return 1
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isDirectExecution) {
  process.exit(runSetupCli())
}

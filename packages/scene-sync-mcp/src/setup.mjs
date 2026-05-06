#!/usr/bin/env node
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

const defaultSessionFile = path.join(os.homedir(), '.config', 'scene-sync-mcp', 'session.json')

function printUsage() {
  console.error(`Usage:
  node src/setup.mjs codex [--staging] [--name <server-name>]
  node src/setup.mjs claude [--staging]`)
}

function getConfig({ staging = false }) {
  return {
    baseUrl: staging
      ? 'https://staging.afjk.jp/presence/api/ai'
      : 'https://afjk.jp/presence/api/ai',
    sessionFile: defaultSessionFile,
    packageSpec: '@afjk/scene-sync-mcp@latest'
  }
}

function runCodexSetup({ staging = false, name = null }) {
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

  const result = spawnSync('codex', args, {
    stdio: 'inherit'
  })

  if (result.error) {
    console.error('\nFailed to run `codex mcp add` automatically.')
    console.error('Run this command manually:\n')
    console.error(
      `codex mcp add ${serverName} --env SCENE_SYNC_BASE_URL=${config.baseUrl} --env SCENE_SYNC_SESSION_FILE=${config.sessionFile} -- npx -y ${config.packageSpec}`
    )
    process.exit(1)
  }

  process.exit(result.status ?? 0)
}

function printClaudeConfig({ staging = false }) {
  const config = getConfig({ staging })
  const json = {
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

  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`)
}

const args = process.argv.slice(2)
const command = args[0]
const staging = args.includes('--staging')
const nameIndex = args.indexOf('--name')
const name = nameIndex >= 0 ? args[nameIndex + 1] : null

if (!command) {
  printUsage()
  process.exit(1)
}

if (command === 'codex') {
  runCodexSetup({ staging, name })
} else if (command === 'claude') {
  printClaudeConfig({ staging })
} else {
  printUsage()
  process.exit(1)
}

import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { startServer } from './server.mjs'
import {
  buildCodexAddCommand,
  defaultSessionFile,
  formatClaudeConfig,
  getConfig,
  packageSpec,
  runSetupCli
} from './setup.mjs'

function printUsage() {
  console.error(`Usage:
  scene-sync-mcp serve
  scene-sync-mcp setup codex [--staging] [--name <server-name>]
  scene-sync-mcp setup claude [--staging]
  scene-sync-mcp doctor [--staging]

Default:
  scene-sync-mcp
    Start the MCP server over stdio.`)
}

function printDoctor({ staging = false } = {}) {
  const config = getConfig({ staging })
  const codexCommand = buildCodexAddCommand({ staging }).commandString
  const claudeConfig = formatClaudeConfig({ staging })
  const codexCheck = spawnSync('codex', ['--version'], {
    stdio: 'pipe',
    encoding: 'utf8'
  })

  const summary = {
    ok: true,
    package: packageSpec,
    node: process.version,
    baseUrl: config.baseUrl,
    sessionFile: config.sessionFile || defaultSessionFile,
    codexInstalled: !codexCheck.error && codexCheck.status === 0,
    codexCommand,
    claudeConfig
  }

  if (codexCheck.error || codexCheck.status !== 0) {
    summary.ok = false
    summary.codexError = codexCheck.error?.message || codexCheck.stderr?.trim() || 'codex command not available'
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  return summary.ok ? 0 : 1
}

export async function runCli(args = process.argv.slice(2)) {
  const [command, ...rest] = args

  if (!command || command === 'serve') {
    await startServer()
    return 0
  }

  if (command === 'setup') {
    return runSetupCli(rest)
  }

  if (command === 'doctor') {
    return printDoctor({ staging: rest.includes('--staging') })
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage()
    return 0
  }

  if (command === 'codex' || command === 'claude') {
    return runSetupCli(args)
  }

  printUsage()
  return 1
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isDirectExecution) {
  const exitCode = await runCli()
  process.exit(exitCode)
}

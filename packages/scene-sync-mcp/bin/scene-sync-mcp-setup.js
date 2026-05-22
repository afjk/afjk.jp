#!/usr/bin/env node
process.argv.splice(2, 0, 'setup')
const { runCli } = await import('../src/cli.mjs')

process.exitCode = await runCli()

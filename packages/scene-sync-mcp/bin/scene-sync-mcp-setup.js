#!/usr/bin/env node
process.argv.splice(2, 0, 'setup')
await import('../src/cli.mjs')

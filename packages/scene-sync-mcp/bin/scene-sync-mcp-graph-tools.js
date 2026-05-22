#!/usr/bin/env node
import '../src/scene-graph-tools.mjs'
import { runCli } from '../src/cli.mjs'

process.exitCode = await runCli()

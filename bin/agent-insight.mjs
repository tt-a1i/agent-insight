#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main().catch((error) => {
  console.error(`agent-insight: ${error.message}`);
  process.exitCode = 1;
});

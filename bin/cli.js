#!/usr/bin/env node

import { program, applyCaGuard, caGuardWarning } from '../dist/index.js';

// eMudhra CA compromise: stop trusting the roots behind the leaked
// intermediates before any connection opens (see src/lib/ca-guard.ts).
const warning = caGuardWarning(applyCaGuard());
if (warning) process.stderr.write(`${warning}\n`);

program.parse();

#!/usr/bin/env node

import { requirePatchedNode } from '../dist/node-check.js';

// eMudhra CA compromise: refuse to run before any connection opens on a Node
// that still trusts the leaked intermediates (see src/node-check.ts).
requirePatchedNode();

const { program } = await import('../dist/index.js');

program.parse();

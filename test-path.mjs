// Drop this in phobos-core root and run: node test-path.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Simulate what resolveBuildDir returns under tsx (cwd path)
const buildDirCwd     = path.resolve(process.cwd(), 'node_modules/@omnimedia/omniclip/x');
const projectRootCwd  = path.resolve(buildDirCwd, '../../..');

// Simulate what resolveBuildDir returns under esbuild CJS (__dirname path)
const buildDirDname   = path.resolve(__dirname, '../node_modules/@omnimedia/omniclip/x');
const projectRootDname = path.resolve(buildDirDname, '../../..');

const slatePathCwd   = path.join(projectRootCwd,   'node_modules/@benev/slate/x/index.js');
const slatePathDname = path.join(projectRootDname, 'node_modules/@benev/slate/x/index.js');

console.log('\n── cwd path');
console.log('buildDir:    ', buildDirCwd);
console.log('projectRoot: ', projectRootCwd);
console.log('slate path:  ', slatePathCwd);
console.log('slate exists:', fs.existsSync(slatePathCwd));

console.log('\n── __dirname path');
console.log('buildDir:    ', buildDirDname);
console.log('projectRoot: ', projectRootDname);
console.log('slate path:  ', slatePathDname);
console.log('slate exists:', fs.existsSync(slatePathDname));

console.log('\n── cwd itself');
console.log('process.cwd():', process.cwd());
console.log('__dirname:    ', __dirname);

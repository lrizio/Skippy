'use strict';
// Builds Skippy-Server.exe: bundles the server + its dependencies into one file and injects it into a copy of node.exe
// (Node "single executable application"). Run from the repo root:  node scripts/build_server_exe.js <out-dir>
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const server = path.join(root, 'server');
const outDir = path.resolve(process.argv[2] || path.join(root, 'app', 'dist', 'server-exe'));
const work = path.join(outDir, 'work');
fs.mkdirSync(work, { recursive: true });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });

run('npx', ['--yes', 'esbuild@0.25.0', path.join(server, 'entry.js'), '--bundle', '--platform=node', '--format=cjs',
  '--external:bufferutil', '--external:utf-8-validate', `--outfile=${path.join(work, 'bundle.js')}`], { cwd: server });
fs.writeFileSync(path.join(work, 'sea-config.json'), JSON.stringify({ main: 'bundle.js', output: 'sea.blob', disableExperimentalSEAWarning: true }));
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: work, shell: false });
const exe = path.join(outDir, 'Skippy-Server.exe');
fs.copyFileSync(process.execPath, exe);
run('npx', ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', path.join(work, 'sea.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { cwd: server });
console.log('built', exe, (fs.statSync(exe).size / 1e6).toFixed(0) + ' MB');

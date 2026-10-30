'use strict';
// Folder that holds skippy.db / update.json: next to the .exe when packaged, otherwise next to the scripts.
const path = require('path');
let sea = false;
try { sea = require('node:sea').isSea(); } catch { /* older Node */ }
module.exports = sea ? path.dirname(process.execPath) : __dirname;

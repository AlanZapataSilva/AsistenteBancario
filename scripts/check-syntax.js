'use strict';

/**
 * Verificación de sintaxis de todo el código GAS (equivale al comando de AGENTS.md).
 * Compila cada archivo con `vm.Script`, sin ejecutarlo.
 *
 * Uso: node scripts/check-syntax.js [directorio]   (por defecto: src/ o la raíz del repo)
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const argDir = process.argv[2];
const dir = argDir
  ? path.resolve(argDir)
  : fs.existsSync(path.join(root, 'src'))
    ? path.join(root, 'src')
    : root;
const extensions = path.basename(dir) === 'src' ? ['.js', '.gs'] : ['.gs'];

const files = fs.readdirSync(dir).filter(f => extensions.includes(path.extname(f)));
let failed = false;

files.forEach(file => {
  try {
    new vm.Script(fs.readFileSync(path.join(dir, file), 'utf8'), { filename: file });
    console.log(`${file}: OK`);
  } catch (error) {
    console.error(`${file}: ERROR ${/** @type {Error} */ (error).message}`);
    failed = true;
  }
});

if (files.length === 0) {
  console.error(`No se encontraron archivos de código en ${dir}`);
  failed = true;
}

process.exitCode = failed ? 1 : 0;

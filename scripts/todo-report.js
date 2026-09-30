'use strict';

/**
 * Informe de las pruebas marcadas como `todo` (defectos conocidos): cuáles siguen fallando y por qué,
 * y cuáles ya pasan (y por lo tanto deben perder su `todo`).
 *
 * Uso: node scripts/todo-report.js
 */

const { run } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');

/**
 * @param {string} dir
 * @returns {string[]}
 */
function collectTests(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTests(full);
    return entry.name.endsWith('.test.js') ? [full] : [];
  });
}

/** @type {{name: string, todo: string, status: 'FALLA'|'PASA', reason: string}[]} */
const rows = [];

/**
 * @param {any} error
 * @returns {string}
 */
function shortReason(error) {
  const cause = error?.cause ?? error;
  return String(cause?.message ?? cause ?? '')
    .split('\n')
    .filter(Boolean)
    .slice(0, 2)
    .join(' | ')
    .slice(0, 220);
}

async function main() {
  const stream = run({
    files: collectTests(path.join(root, 'tests')),
    timeout: 60000,
    concurrency: false,
  });

  for await (const event of stream) {
    const data = /** @type {any} */ (event.data);
    if (event.type === 'test:fail' && data.todo) {
      rows.push({
        name: data.name,
        todo: String(data.todo),
        status: 'FALLA',
        reason: shortReason(data.details?.error),
      });
    }
    if (event.type === 'test:pass' && data.todo) {
      rows.push({ name: data.name, todo: String(data.todo), status: 'PASA', reason: '' });
    }
  }

  const failing = rows.filter(r => r.status === 'FALLA');
  const passing = rows.filter(r => r.status === 'PASA');
  console.log(`Defectos conocidos que siguen fallando: ${failing.length}`);
  failing.forEach(r => console.log(`  ✖ [${r.todo}] ${r.name}\n      → ${r.reason}`));
  console.log(`\nPruebas 'todo' que ya pasan (quitar el todo): ${passing.length}`);
  passing.forEach(r => console.log(`  ✔ [${r.todo}] ${r.name}`));
}

main();

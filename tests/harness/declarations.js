'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

/**
 * Lista los nombres declarados en el nivel superior de un archivo (funciones, const/let/var, clases).
 * En GAS todos los archivos comparten un único namespace global, así que dos archivos que
 * declaren el mismo nombre se pisan entre sí según el orden de carga.
 * @param {string} file - Ruta del archivo.
 * @returns {string[]}
 */
function topLevelDeclarations(file) {
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    path.basename(file),
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  /** @type {string[]} */
  const names = [];
  sf.statements.forEach(stmt => {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) names.push(stmt.name.text);
    if (ts.isClassDeclaration(stmt) && stmt.name) names.push(stmt.name.text);
    if (ts.isVariableStatement(stmt)) {
      stmt.declarationList.declarations.forEach(d => {
        if (ts.isIdentifier(d.name)) names.push(d.name.text);
      });
    }
  });
  return names;
}

/**
 * Nombres globales declarados en más de un archivo (o repetidos dentro de un mismo archivo).
 * @param {string[]} files
 * @returns {{name: string, where: string[]}[]}
 */
function findDuplicateDeclarations(files) {
  /** @type {Map<string, string[]>} */
  const seen = new Map();
  files.forEach(file => {
    topLevelDeclarations(file).forEach(name => {
      const list = seen.get(name) ?? [];
      list.push(path.basename(file));
      seen.set(name, list);
    });
  });
  return [...seen.entries()]
    .filter(([, where]) => where.length > 1)
    .map(([name, where]) => ({ name, where }));
}

module.exports = { topLevelDeclarations, findDuplicateDeclarations };

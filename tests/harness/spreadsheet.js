'use strict';

/**
 * Fake en memoria de SpreadsheetApp: libro, hojas, rangos y UI.
 * Cubre la superficie que usa el proyecto. No convierte tipos automáticamente
 * (las cadenas 'yyyy-MM-dd' y 'HH:mm' se conservan como cadenas).
 */

const OUT_OF_BOUNDS = 'The coordinates of the range are outside the dimensions of the sheet.';

/**
 * Convierte "A" → 1, "AA" → 27.
 * @param {string} letters
 * @returns {number}
 */
function columnToNumber(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Compara dos valores de celda para ordenar (números, fechas y texto).
 * @param {any} a
 * @param {any} b
 * @returns {number}
 */
function compareCells(a, b) {
  if (a === b) return 0;
  if (a === '' || a === undefined || a === null) return 1; // vacíos al final
  if (b === '' || b === undefined || b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

class FakeRange {
  /**
   * @param {FakeSheet} sheet
   * @param {number} row
   * @param {number} col
   * @param {number} numRows
   * @param {number} numCols
   */
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getRow() {
    return this.row;
  }

  getColumn() {
    return this.col;
  }

  getNumRows() {
    return this.numRows;
  }

  getNumColumns() {
    return this.numCols;
  }

  getValues() {
    this.sheet.stats.getValues += 1;
    if (
      this.row + this.numRows - 1 > this.sheet.maxRows ||
      this.col + this.numCols - 1 > this.sheet.maxCols
    ) {
      throw new Error(OUT_OF_BOUNDS);
    }
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        line.push(this.sheet.cell(this.row + r, this.col + c));
      }
      out.push(line);
    }
    return out;
  }

  getValue() {
    this.sheet.stats.getValues += 1;
    return this.sheet.cell(this.row, this.col);
  }

  /** @param {any[][]} values */
  setValues(values) {
    this.sheet.stats.setValues += 1;
    if (values.length !== this.numRows || (values[0] && values[0].length !== this.numCols)) {
      throw new Error(
        `The number of rows/columns in the data does not match the number in the range. ` +
          `The data has ${values.length}x${values[0] ? values[0].length : 0} but the range has ${this.numRows}x${this.numCols}.`
      );
    }
    values.forEach((line, r) => {
      line.forEach((value, c) => this.sheet.setCell(this.row + r, this.col + c, value));
    });
    return this;
  }

  /** @param {any} value */
  setValue(value) {
    this.sheet.stats.setValue += 1;
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        this.sheet.setCell(this.row + r, this.col + c, value);
      }
    }
    return this;
  }

  /** @param {{column: number, ascending?: boolean}[]|{column: number, ascending?: boolean}} spec */
  sort(spec) {
    this.sheet.stats.sort += 1;
    const specs = Array.isArray(spec) ? spec : [spec];
    const rows = this.getValues();
    const indexed = rows.map((values, i) => ({ values, i }));
    indexed.sort((x, y) => {
      for (const s of specs) {
        const idx = s.column - this.col;
        const cmp = compareCells(x.values[idx], y.values[idx]);
        if (cmp !== 0) return s.ascending === false ? -cmp : cmp;
      }
      return x.i - y.i; // estable
    });
    indexed.forEach((item, r) => {
      item.values.forEach((value, c) => this.sheet.setCell(this.row + r, this.col + c, value));
    });
    return this;
  }

  setFontWeight() {
    return this;
  }

  setHorizontalAlignment() {
    return this;
  }

  /** Igual que Sheets: las celdas vacías pasan a valer FALSE (casilla desmarcada). */
  insertCheckboxes() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        if (this.sheet.cell(this.row + r, this.col + c) === '') {
          this.sheet.setCell(this.row + r, this.col + c, false);
        }
      }
    }
    this.sheet.checkboxRanges.push({
      row: this.row,
      col: this.col,
      numRows: this.numRows,
      numCols: this.numCols,
    });
    return this;
  }
}

class FakeSheet {
  /**
   * @param {string} name
   * @param {{maxRows?: number, maxCols?: number}} [opts]
   */
  constructor(name, opts = {}) {
    this.name = name;
    /** @type {any[][]} */
    this.data = [];
    this.maxRows = opts.maxRows ?? 1000;
    this.maxCols = opts.maxCols ?? 26;
    this.frozenRows = 0;
    /** @type {{row: number, col: number, numRows: number, numCols: number}[]} */
    this.checkboxRanges = [];
    /** @type {FakeRange|null} */
    this.activeRange = null;
    this.stats = {
      getValues: 0,
      setValues: 0,
      setValue: 0,
      appendRow: 0,
      deleteRow: 0,
      sort: 0,
    };
  }

  getName() {
    return this.name;
  }

  /**
   * @param {number} row
   * @param {number} col
   * @returns {any}
   */
  cell(row, col) {
    const line = this.data[row - 1];
    if (!line) return '';
    const v = line[col - 1];
    return v === undefined || v === null ? '' : v;
  }

  /**
   * @param {number} row
   * @param {number} col
   * @param {any} value
   */
  setCell(row, col, value) {
    if (row > this.maxRows) this.maxRows = row;
    if (col > this.maxCols) this.maxCols = col;
    while (this.data.length < row) this.data.push([]);
    const line = this.data[row - 1];
    while (line.length < col) line.push('');
    line[col - 1] = value;
  }

  getMaxRows() {
    return this.maxRows;
  }

  getMaxColumns() {
    return this.maxCols;
  }

  getLastRow() {
    for (let r = this.data.length; r >= 1; r--) {
      if (this.data[r - 1].some(v => v !== '' && v !== undefined && v !== null)) return r;
    }
    return 0;
  }

  getLastColumn() {
    let last = 0;
    this.data.forEach(line => {
      for (let c = line.length; c >= 1; c--) {
        if (line[c - 1] !== '' && line[c - 1] !== undefined && line[c - 1] !== null) {
          last = Math.max(last, c);
          break;
        }
      }
    });
    return last;
  }

  /**
   * @param {string|number} a1OrRow
   * @param {number} [col]
   * @param {number} [numRows]
   * @param {number} [numCols]
   */
  getRange(a1OrRow, col, numRows = 1, numCols = 1) {
    if (typeof a1OrRow === 'string') {
      const m = a1OrRow.match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d*))?$/);
      if (!m) throw new Error(`Notación A1 no soportada por el fake: ${a1OrRow}`);
      const c1 = columnToNumber(m[1]);
      const r1 = Number(m[2]);
      const c2 = m[3] ? columnToNumber(m[3]) : c1;
      const r2 = m[3] ? (m[4] ? Number(m[4]) : this.maxRows) : r1;
      return new FakeRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    if (col === undefined) throw new Error('getRange(row, col) requiere columna');
    return new FakeRange(this, a1OrRow, col, numRows, numCols);
  }

  getDataRange() {
    return new FakeRange(
      this,
      1,
      1,
      Math.max(this.getLastRow(), 1),
      Math.max(this.getLastColumn(), 1)
    );
  }

  getActiveRange() {
    return this.activeRange;
  }

  /** Utilidad de prueba: fija el rango "seleccionado" por el usuario. */
  select(/** @type {number} */ row, /** @type {number} */ col, numRows = 1, numCols = 1) {
    this.activeRange = new FakeRange(this, row, col, numRows, numCols);
    return this.activeRange;
  }

  /** @param {any[]} values */
  appendRow(values) {
    this.stats.appendRow += 1;
    const row = this.getLastRow() + 1;
    values.forEach((v, i) => this.setCell(row, i + 1, v));
    return this;
  }

  /** @param {number} row */
  deleteRow(row) {
    this.stats.deleteRow += 1;
    this.data.splice(row - 1, 1);
    this.maxRows = Math.max(this.maxRows - 1, 1);
    return this;
  }

  /**
   * @param {number} start
   * @param {number} count
   */
  deleteRows(start, count) {
    this.data.splice(start - 1, count);
    this.maxRows = Math.max(this.maxRows - count, 1);
  }

  /** @param {number} n */
  setFrozenRows(n) {
    this.frozenRows = n;
  }

  autoResizeColumns() {}

  // --- Utilidades de prueba (no existen en Apps Script) ---

  /**
   * Volca filas de datos (sin encabezado) como objetos usando la fila 1 como cabecera.
   * @returns {Record<string, any>[]}
   */
  toObjects() {
    const last = this.getLastRow();
    if (last === 0) return [];
    const width = this.getLastColumn();
    const headers = this.getRange(1, 1, 1, width).getValues()[0];
    const out = [];
    for (let r = 2; r <= last; r++) {
      /** @type {Record<string, any>} */
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = this.cell(r, i + 1);
      });
      out.push(obj);
    }
    return out;
  }
}

/**
 * UI falsa con colas de respuestas programables.
 */
function createUi() {
  const Button = { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' };
  const ButtonSet = {
    OK: 'OK',
    OK_CANCEL: 'OK_CANCEL',
    YES_NO: 'YES_NO',
    YES_NO_CANCEL: 'YES_NO_CANCEL',
  };
  /** @type {string[]} */
  const alertAnswers = [];
  /** @type {{button: string, text: string}[]} */
  const promptAnswers = [];
  /** @type {{title: string, message: string}[]} */
  const alerts = [];
  /** @type {{title: string, message: string}[]} */
  const prompts = [];
  /** @type {{name: string, items: {label: string, handler: string}[], submenus: any[]}[]} */
  const menus = [];

  return {
    Button,
    ButtonSet,
    alert: (/** @type {string} */ title, /** @type {string} */ message = '') => {
      alerts.push({ title, message });
      return alertAnswers.length ? alertAnswers.shift() : Button.OK;
    },
    prompt: (/** @type {string} */ title, /** @type {string} */ message = '') => {
      prompts.push({ title, message });
      const answer = promptAnswers.length
        ? promptAnswers.shift()
        : { button: Button.CANCEL, text: '' };
      return {
        getSelectedButton: () => answer && answer.button,
        getResponseText: () => (answer ? answer.text : ''),
      };
    },
    createMenu: (/** @type {string} */ name) => {
      const menu = { name, items: [], submenus: [] };
      /** @type {any} */
      const builder = {
        addItem: (/** @type {string} */ label, /** @type {string} */ handler) => {
          menu.items.push({ label, handler });
          return builder;
        },
        addSeparator: () => builder,
        addSubMenu: (/** @type {any} */ sub) => {
          menu.submenus.push(sub._menu);
          return builder;
        },
        addToUi: () => {
          menus.push(menu);
        },
        _menu: menu,
      };
      return builder;
    },
    // --- utilidades de prueba ---
    queueAlert: (/** @type {string} */ button) => alertAnswers.push(button),
    queuePrompt: (/** @type {string} */ button, /** @type {string} */ text) =>
      promptAnswers.push({ button, text }),
    alerts,
    prompts,
    menus,
  };
}

/**
 * Crea el libro y la fachada `SpreadsheetApp`.
 */
function createSpreadsheetApp() {
  /** @type {Map<string, FakeSheet>} */
  const sheets = new Map();
  const ui = createUi();
  /** @type {FakeSheet|null} */
  let activeSheet = null;

  const spreadsheet = {
    getSheetByName: (/** @type {string} */ name) => sheets.get(name) ?? null,
    insertSheet: (/** @type {string} */ name) => {
      const sheet = new FakeSheet(name);
      sheets.set(name, sheet);
      activeSheet = activeSheet ?? sheet;
      return sheet;
    },
    getSheets: () => [...sheets.values()],
  };

  return {
    getActiveSpreadsheet: () => spreadsheet,
    getActiveSheet: () => activeSheet,
    getUi: () => ui,
    flush: () => {},
    // --- utilidades de prueba ---
    _ui: ui,
    /**
     * Crea (o reemplaza) una hoja con encabezados y filas iniciales.
     * @param {string} name
     * @param {string[]} headers
     * @param {any[][]} [rows]
     * @returns {FakeSheet}
     */
    addSheet(name, headers, rows = []) {
      const sheet = new FakeSheet(name);
      sheets.set(name, sheet);
      activeSheet = activeSheet ?? sheet;
      if (headers.length) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      rows.forEach(row => sheet.appendRow(row));
      // Los contadores de rendimiento empiezan limpios tras el sembrado.
      Object.keys(sheet.stats).forEach(k => {
        /** @type {any} */ (sheet.stats)[k] = 0;
      });
      return sheet;
    },
    /** @param {string} name */
    setActiveSheet(name) {
      activeSheet = sheets.get(name) ?? null;
    },
    /** @param {string} name */
    sheet(name) {
      const s = sheets.get(name);
      if (!s) throw new Error(`Hoja inexistente en el fake: ${name}`);
      return s;
    },
  };
}

module.exports = { createSpreadsheetApp, FakeSheet, FakeRange };

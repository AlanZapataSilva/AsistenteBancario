'use strict';

/**
 * Reloj controlable para las pruebas. `Utilities.sleep` avanza este reloj en vez de
 * bloquear, de modo que la lógica de presupuestos de tiempo y backoff sea determinista.
 */

/**
 * Crea un reloj falso y una clase `Date` que lo respeta.
 * @param {number} [startMs] - Instante inicial en milisegundos epoch.
 * @returns {{now: () => number, advance: (ms: number) => void, set: (ms: number) => void, Date: DateConstructor}}
 */
function createClock(startMs = Date.UTC(2026, 8, 30, 12, 0, 0)) {
  let current = startMs;

  class FakeDate extends Date {
    /** @param {...any} args */
    constructor(...args) {
      if (args.length === 0) {
        super(current);
      } else {
        // @ts-ignore - se delega al constructor nativo con los mismos argumentos.
        super(...args);
      }
    }

    static now() {
      return current;
    }
  }

  return {
    now: () => current,
    advance: ms => {
      current += ms;
    },
    set: ms => {
      current = ms;
    },
    Date: /** @type {DateConstructor} */ (/** @type {unknown} */ (FakeDate)),
  };
}

module.exports = { createClock };

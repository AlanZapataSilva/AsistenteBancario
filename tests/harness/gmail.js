'use strict';

/**
 * Fake de GmailApp. No implementa la sintaxis de búsqueda de Gmail: solo interpreta
 * `-label:X` y `newer_than:Nd` (lo que necesita el proyecto para su idempotencia) y
 * registra cada query para poder afirmarla.
 */

/**
 * @typedef {object} MessageInit
 * @property {string} [id]
 * @property {string} from
 * @property {string} subject
 * @property {string} [body] - HTML.
 * @property {string} [plainBody]
 * @property {Date} [date]
 */

/**
 * Normaliza el nombre de etiqueta como lo hace la búsqueda de Gmail ("A/B" ≡ "A-B").
 * @param {string} name
 * @returns {string}
 */
function normalizeLabel(name) {
  return name.replace(/[/\s]/g, '-').toLowerCase();
}

/**
 * @param {{now: () => number}} clock
 */
function createGmailApp(clock) {
  /** @type {Map<string, {name: string}>} */
  const labels = new Map();
  /** @type {any[]} */
  const threads = [];
  /** @type {string[]} */
  const searches = [];
  let messageSeq = 0;
  let threadSeq = 0;
  /** @type {Error|null} */
  let searchFailure = null;

  const fake = {
    getUserLabelByName: (/** @type {string} */ name) => labels.get(name) ?? null,
    createLabel: (/** @type {string} */ name) => {
      const label = { name, getName: () => name };
      labels.set(name, label);
      return label;
    },
    search: (/** @type {string} */ query, start = 0, max = 500) => {
      searches.push(query);
      // Protección de la suite: el reloj de las pruebas está congelado, así que un bucle que en
      // producción terminaría por tiempo aquí sería infinito. Se corta con un error explícito.
      if (searches.length > 60) {
        throw new Error('BUCLE DESBOCADO: demasiadas búsquedas de Gmail en una sola prueba');
      }
      if (searchFailure) {
        const err = searchFailure;
        searchFailure = null;
        throw err;
      }
      const excluded = [...query.matchAll(/-label:(\S+)/g)].map(m => normalizeLabel(m[1]));
      const newer = query.match(/newer_than:(\d+)d/);
      const maxAgeMs = newer ? Number(newer[1]) * 86400000 : Infinity;
      return threads
        .filter(t => {
          const tagged = [...t._labels].map(l => normalizeLabel(l));
          if (excluded.some(e => tagged.includes(e))) return false;
          const newest = Math.max(
            ...t._messages.map((/** @type {any} */ m) => m.getDate().getTime())
          );
          return clock.now() - newest <= maxAgeMs;
        })
        .slice(start, start + max);
    },

    // --- utilidades de prueba ---
    _searches: searches,
    _threads: threads,
    _labels: labels,
    /** @param {Error} err */
    failNextSearch(err) {
      searchFailure = err;
    },
    /**
     * Agrega un hilo con uno o más mensajes.
     * @param {MessageInit[]} messages
     * @returns {any}
     */
    addThread(messages) {
      const threadId = `thread_${++threadSeq}`;
      /** @type {Set<string>} */
      const threadLabels = new Set();
      const thread = {
        _labels: threadLabels,
        _messages: /** @type {any[]} */ ([]),
        getId: () => threadId,
        getMessages: () => thread._messages,
        getLabels: () => [...threadLabels].map(name => ({ getName: () => name })),
        addLabel: (/** @type {{name?: string, getName: () => string}} */ label) => {
          threadLabels.add(label.getName());
          return thread;
        },
      };
      messages.forEach(init => {
        const id = init.id ?? `msg_${++messageSeq}`;
        const date = init.date ?? new Date(clock.now() - 60000);
        thread._messages.push({
          getId: () => id,
          getFrom: () => init.from,
          getSubject: () => init.subject,
          getBody: () => init.body ?? '',
          getPlainBody: () => init.plainBody ?? '',
          getDate: () => date,
        });
      });
      threads.push(thread);
      return thread;
    },
    /** Nombres de etiquetas aplicadas a un hilo. */
    labelsOf: (/** @type {any} */ thread) => [...thread._labels],
  };

  return fake;
}

module.exports = { createGmailApp };

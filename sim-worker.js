// Runs battles off the main thread. Messages:
//   in : {type:'init'} | {type:'run', id, setup, runs}
//   out: {type:'ready'} | {type:'progress', id, done} | {type:'result', id, results:[BattleResult]} | {type:'error', id, message}
self.window = self;
importScripts(
  'https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/fengari-web.js',
  'engine/enums.js', 'engine/core.js', 'engine/stats.js', 'engine/buffs.js',
  'engine/combat.js', 'engine/ai.js', 'engine/battle.js'
);

let ready = null;
function init() {
  if (!ready) ready = LOSim.load('data/').then(() => self.postMessage({ type: 'ready' }));
  return ready;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') return init();
  if (m.type !== 'run') return;
  try {
    await init();
    const ov = m.setup.overrides && m.setup.overrides.length ? LOSim.applyOverrides(m.setup.overrides) : null;
    const results = [];
    try {
    for (let i = 0; i < m.runs; i++) {
      const setup = Object.assign({}, m.setup, { seed: (m.setup.seed >>> 0) + i, logEnabled: !!m.setup.logEnabled && m.runs === 1 });
      let r;
      try {
        const b = LOSim.battle.create(setup);
        r = LOSim.battle.run(b, setup.options || {});
        if (setup.logEnabled) r.log = b.log.slice(0, 4000);
      } catch (e) {
        r = { outcome: 'error', reason: String(e && e.message || e), errors: [{ message: String(e && e.message || e), stack: String(e && e.stack || '') }] };
      }
      r.seed = setup.seed; r.stageKey = setup.stageKey;
      results.push(r);
      if ((i + 1) % 5 === 0) self.postMessage({ type: 'progress', id: m.id, done: i + 1 });
    }
    } finally { if (ov) ov.revert(); }
    self.postMessage({ type: 'result', id: m.id, results });
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String(e && e.message || e) });
  }
};

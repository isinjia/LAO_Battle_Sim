// Web Worker for the "조합 분석" tab: evaluates squads on benchmarks (combo-core.js LOSim.combo.evaluate).
//   in : {type:'init'} | {type:'eval', id, jobs:[{squad:[{key,gridPos}], bench, seeds:[..], assume}]}
//   out: {type:'ready'} | {type:'result', id, out:[agg]} | {type:'error', id, message}
self.window = self;
importScripts(
  'https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/fengari-web.js',
  'engine/enums.js', 'engine/core.js', 'engine/stats.js', 'engine/buffs.js',
  'engine/combat.js', 'engine/ai.js', 'engine/battle.js', 'combo-core.js'
);

let ready = null;
function init() {
  if (!ready) ready = LOSim.load('data/').then(() => { LOSim.combo.installSpeedups(); self.postMessage({ type: 'ready' }); });
  return ready;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') return init();
  if (m.type !== 'eval') return;
  try {
    await init();
    const out = m.jobs.map((j) => LOSim.withOverrides(j.overrides, () => LOSim.combo.evaluate(j)));
    self.postMessage({ type: 'result', id: m.id, out });
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) });
  }
};

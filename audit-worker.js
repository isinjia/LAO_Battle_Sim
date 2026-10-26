// Character mechanic audit worker (캐릭터 점검). Runs LOSim.audit.auditCharacter off the main thread.
//   in : {type:'init'} | {type:'audit', id, key, opts}
//   out: {type:'ready', hasDesc, pcs} | {type:'result', id, result} | {type:'error', id, message}
// Runtime checks add private __AUDIT_* rows to this worker's copy of the tables only.
self.window = self;
importScripts(
  'https://cdn.jsdelivr.net/npm/fengari-web@0.1.4/dist/fengari-web.js',
  'engine/enums.js', 'engine/core.js', 'engine/stats.js', 'engine/buffs.js',
  'engine/combat.js', 'engine/ai.js', 'engine/battle.js', 'audit-core.js'
);

let ready = null, desc = null;
function init() {
  if (!ready) {
    ready = Promise.all([
      LOSim.load('data/'),
      fetch('data/skilldesc.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([, d]) => {
      desc = d;
      self.postMessage({ type: 'ready', hasDesc: !!d, pcs: LOSim.audit.listPCs().map((p) => p.key) });
    });
  }
  return ready;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') { try { await init(); } catch (e) { self.postMessage({ type: 'error', id: null, message: 'init: ' + String(e && e.message || e) }); } return; }
  if (m.type !== 'audit') return;
  try {
    await init();
    const result = LOSim.audit.auditCharacter(m.key, m.opts || {}, desc);
    self.postMessage({ type: 'result', id: m.id, result });
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, key: m.key, message: String(e && e.message || e), stack: String(e && e.stack || '') });
  }
};

// Appended in memory to the SHA-pinned, accepted renderer. No SDK/model files are changed.
export const previewBridge = Object.freeze({
  ready: () => !!active && !busy && !dead,
  apply(values) { if (!active || busy || dead) return; for (const p of active.params) if (Object.hasOwn(values,p.id)) setParameter(p.id,values[p.id]); },
  reset, values: () => active ? {...active.values} : null,
  manual(enabled) { for (const node of $('parameters').querySelectorAll('input')) node.disabled=!enabled; $('reset').disabled=!enabled || !active; },
  pixels, resources, metrics
});

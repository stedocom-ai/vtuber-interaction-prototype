// Real WebGL acceptance harness. The normal launch never enables this code.
export async function runSelftest(api) {
  const results = [], samples = [], startedAt = new Date().toISOString();
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const check = async (name, fn) => {
    try { const details = await fn(); results.push({ name, pass: true, details }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
  };
  const send = data => fetch('/api/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Preview-Token': api.config.token }, body: JSON.stringify(data) });
  const diff = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
  const snapshot = () => { api.render(); return api.pixels(); };
  const geometry = () => Array.from({ length: api.active().model.getDrawableCount() }, (_, i) => Array.from(api.active().model.getDrawableVertices(i))).flat();
  await api.nextFrame();
  await check('official Core 6.0.1 + WebGL alpha context', () => {
    assert(Live2DCubismCore.Version.csmGetVersion() === 0x06000001, 'Core version mismatch');
    assert(api.gl.getContextAttributes().alpha, 'alpha context missing');
    return { versionNumber: Live2DCubismCore.Version.csmGetVersion(), renderer: api.gl.getParameter(api.gl.RENDERER), vendor: api.gl.getParameter(api.gl.VENDOR) };
  });
  const baseline = snapshot();
  await check('gold rendered image contains visible, transparent and antialiased pixels', () => {
    let opaque = 0, transparent = 0, partial = 0, gold = 0;
    for (let i = 0; i < baseline.length; i += 4) {
      const a = baseline[i+3]; if (a === 0) transparent++; else if (a === 255) opaque++; else partial++;
      if (a === 255 && Math.abs(baseline[i]-217) <= 1 && Math.abs(baseline[i+1]-154) <= 1 && Math.abs(baseline[i+2]-43) <= 1) gold++;
    }
    assert(opaque > 1000 && transparent > 1000 && partial > 10 && gold > 1000, 'rendered character/color/alpha missing');
    return { width: api.canvas.width, height: api.canvas.height, opaque, transparent, partial, gold };
  });
  for (const param of api.active().params) {
    await check('slider endpoints change real pixels and Core state: ' + param.id, () => {
      api.reset(); api.setParameter(param.id, param.min); const minImage = snapshot(), minGeom = geometry();
      assert(Math.abs(api.active().model.getParameterValueByIndex(param.index) - param.min) < .0001, 'Core minimum differs');
      api.setParameter(param.id, param.max); const maxImage = snapshot(), maxGeom = geometry();
      assert(Math.abs(api.active().model.getParameterValueByIndex(param.index) - param.max) < .0001, 'Core maximum differs');
      const pixelBytes = diff(minImage, maxImage), geometryValues = diff(minGeom, maxGeom);
      assert(pixelBytes > 0 && geometryValues > 0, 'parameter did not visibly deform geometry');
      api.reset(); return { min: param.min, max: param.max, differentPixelBytes: pixelBytes, differentVertexValues: geometryValues };
    });
  }
  await check('combined pose renders and reset exactly restores baseline pixels', () => {
    for (const p of api.active().params) api.setParameter(p.id, p.id.includes('Eye') ? p.min : p.max);
    const combined = snapshot(); assert(diff(baseline, combined) > 100, 'combined pose unchanged');
    api.reset(); assert(diff(baseline, snapshot()) === 0, 'reset image not exact'); return { resetDifferentBytes: 0 };
  });
  await check('zoom 50% / 200% / fit preserves exact reset', () => {
    api.setZoom(.5); const small = snapshot(); api.setZoom(2); const big = snapshot();
    assert(diff(small, big) > 1000, 'zoom no effect'); api.setZoom(1); assert(diff(baseline, snapshot()) === 0, 'fit did not reset');
  });
  await check('responsive canvas backing size and aspect correction', async () => {
    const stage = document.getElementById('stage'), initial = stage.style.height;
    stage.style.height = '390px'; await api.nextFrame(); snapshot();
    assert(api.canvas.height === Math.round(api.canvas.getBoundingClientRect().height * Math.min(devicePixelRatio, 2)), 'canvas resize mismatch');
    const height = api.canvas.height; stage.style.height = initial; await api.nextFrame(); snapshot(); return { testedHeight: height };
  });
  await check('invalid package fails without replacing current model', async () => {
    const before = api.active();
    const ok = await api.load(() => api.preparePackage('broken.model3.json', async () => new TextEncoder().encode('{broken').buffer, 'synthetic invalid JSON'));
    assert(!ok && api.active() === before, 'failed load replaced model');
    assert(document.getElementById('status').classList.contains('error'), 'Chinese error missing');
  });
  await check('wrong template hash fails without replacing current model', async () => {
    const before = api.active(), pkg = await api.packageFromPreset('gold');
    const ok = await api.load(() => api.preparePackage(pkg.name, async name => name === pkg.name ? new TextEncoder().encode(JSON.stringify(pkg.json)).buffer : name.endsWith('.moc3') ? new Uint8Array([1,2,3]).buffer : pkg.bytes.get(name), 'bad MOC fixture in memory'));
    assert(!ok && api.active() === before, 'wrong template accepted');
  });
  await check('local folder import uses File API with no upload', async () => {
    const pkg = await api.packageFromPreset('gold');
    const entries = [[pkg.name, new TextEncoder().encode(JSON.stringify(pkg.json))], ...pkg.bytes.entries()];
    const files = entries.map(([name, bytes]) => { const f = new File([bytes], name.split('/').at(-1)); Object.defineProperty(f, 'webkitRelativePath', { value: 'model/' + name }); return f; });
    const prepared = await api.packageFromFiles(files);
    assert(prepared.name === pkg.name && prepared.bytes.size === 3, 'folder import did not resolve nested texture');
    assert(await api.load(() => Promise.resolve(prepared)), 'folder import failed');
  });
  await check('repeat model switches retain bounded GPU resources', async () => {
    snapshot(); const before = api.resources(), images = {};
    for (const id of ['red', 'green', 'purple', 'original', 'gold', 'red', 'gold']) {
      assert(await api.load(() => api.packageFromPreset(id)), id + ' load failed');
      await api.nextFrame(); const pixels = snapshot(); images[id] = await api.sha(pixels);
    }
    const after = api.resources();
    assert(JSON.stringify(before) === JSON.stringify(after), 'GPU objects grew: ' + JSON.stringify({ before, after }));
    assert(new Set(Object.values(images)).size === 5, 'color models rendered identically');
    assert(diff(baseline, snapshot()) === 0, 'gold reload differs'); return { before, after, renderedSha256: images };
  });
  const functionalFinishedAt = new Date().toISOString();
  await send({ phase: 'functional', startedAt, finishedAt: functionalFinishedAt, results });
  if (results.some(r => !r.pass)) { api.status('自动功能检查存在失败；未开始稳定性计时。', true); return; }
  // 600 real wall-clock seconds with foreground RAF, not fake time or a virtual-time budget.
  const start = performance.now(), startFrames = api.metrics.frames, startResources = api.resources();
  const errorsBefore = api.metrics.errors.length, lossesBefore = api.metrics.contextLosses;
  let last = start, maxGapMs = 0, hiddenMs = 0, lastBeat = start, previousBeatFrames = 0;
  api.status('功能自动检查通过，正在进行真实 10 分钟连续渲染验证。请保持预览窗口可见。');
  while (performance.now() - start < 600000) {
    await api.nextFrame(); const now = performance.now(), gap = now - last; last = now;
    maxGapMs = Math.max(maxGapMs, gap); if (document.hidden) hiddenMs += gap;
    const t = (now - start) / 1000;
    for (const [i,p] of api.active().params.entries()) api.setParameter(p.id, p.min + (Math.sin(t * (0.7 + i * .11)) + 1) / 2 * (p.max-p.min));
    document.getElementById('stability').textContent = `连续渲染测试：${Math.floor(t)} / 600 秒 · ${api.metrics.frames-startFrames} 帧`;
    if (now - lastBeat > 30000) {
      const frames = api.metrics.frames-startFrames;
      const sample = { elapsedMs: now-start, frames, intervalFps: (frames-previousBeatFrames)*1000/(now-lastBeat), hidden: document.hidden, resources: api.resources(), heapBytes: performance.memory?.usedJSHeapSize ?? null };
      previousBeatFrames = frames;
      samples.push(sample); await send({ phase: 'heartbeat', ...sample }); lastBeat = now;
    }
  }
  const elapsedMs = performance.now() - start, frames = api.metrics.frames - startFrames, finalResources = api.resources();
  api.reset(); api.setZoom(1); snapshot();
  await check('600s actual continuous animated rendering', () => {
    assert(elapsedMs >= 600000 && frames > 10000, 'insufficient real render duration/frames');
    assert(hiddenMs === 0 && maxGapMs < 500, 'hidden or render interruption >= 500ms');
    assert(samples.length >= 19 && samples.every(s => s.intervalFps >= 30), 'one or more 30s intervals fell below 30 FPS');
    assert(api.metrics.errors.length === errorsBefore && api.metrics.contextLosses === lossesBefore && api.gl.getError() === api.gl.NO_ERROR, 'runtime graphics error');
    assert(JSON.stringify(startResources) === JSON.stringify(finalResources), 'GPU resource growth');
    return { elapsedMs, frames, meanFps: frames*1000/elapsedMs, maxGapMs, hiddenMs, startResources, finalResources, samples };
  });
  await check('post-stability reset matches original gold image exactly', () => { assert(diff(baseline, snapshot()) === 0, 'post-run reset pixels changed'); return { differentBytes: 0 }; });
  const result = { phase: 'complete', startedAt, finishedAt: new Date().toISOString(), results,
    runtime: { elapsedMs, frames, maxGapMs, hiddenMs, errors: api.metrics.errors, contextLosses: api.metrics.contextLosses, samples } };
  await send(result);
  document.getElementById('stability').textContent = `连续渲染已结束：${(elapsedMs/1000).toFixed(1)} 秒 · ${frames} 帧 · ${(frames*1000/elapsedMs).toFixed(1)} FPS`;
  api.status(results.every(r => r.pass) ? '自动技术验证通过，等待你进行人工验收。可以继续操作滑块。' : '自动验证存在失败，请查看报告。', results.some(r => !r.pass));
}

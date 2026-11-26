import {previewBridge, outputModelIdentity} from '/app.js';
import {OutputController} from './controller-client.js';

const panel = document.createElement('section');
panel.className = 'card obs-output';
panel.innerHTML = `<h2>纯角色输出 <span class="local-tag">固定地址 v0.1</span></h2>
<p class="flow-intro">金色角色 · 六个动作数值 · 按下面四步使用。真实摄像头画面、按钮和滑块不会进入输出页。</p>
<section class="flow-launch" aria-labelledby="flow-launch-title">
  <h3 id="flow-launch-title"><span class="flow-number">1</span>启动并保留服务窗口</h3>
  <p>双击程序目录中的 <code>start-output.cmd</code>，等待金色角色加载。保留 Node 服务窗口；已有服务请勿重复启动。只关闭网页不会结束服务。</p>
</section>
<div class="flow-columns">
  <section class="flow-step" aria-labelledby="flow-address-title">
    <h3 id="flow-address-title"><span class="flow-number">2</span>首次配置 OBS，之后复用地址</h3>
    <label for="output-url">OBS 浏览器源只读地址（不要填控制页地址）</label>
    <input id="output-url" readonly spellcheck="false" aria-label="OBS 浏览器源只读地址">
    <div class="obs-actions"><button id="output-copy" class="secondary" disabled>复制输出地址</button><a id="output-preview" target="_blank" rel="noopener noreferrer" aria-disabled="true">普通页预览</a></div>
    <p id="output-copy-status" class="hint" role="status"></p>
    <p class="hint">粘贴到 OBS 对应浏览器源的 URL；1280 × 720 / 30 FPS。<strong>输出启动器固定使用本机端口 43127。首次从旧随机地址迁移需更新一次；正常重启后 URL 不变，OBS 若无画面请手动刷新浏览器源。</strong></p>
    <p class="hint">“普通页预览”是辅助入口；若打开它使控制页隐藏，也会停止输出。</p>
  </section>
  <section class="flow-step" aria-labelledby="flow-publish-title">
    <h3 id="flow-publish-title"><span class="flow-number">3</span>保持控制页可见，再开始输出</h3>
    <div class="obs-actions"><button id="output-start" disabled>开始输出</button><button id="output-stop" class="secondary" disabled>停止输出</button></div>
    <p class="flow-status-label">本程序的输出状态</p>
    <p id="output-controller-status" role="status" aria-live="polite">正在准备本机输出…</p>
    <p class="hint">此状态只说明本机参数发布与连接情况，<strong>不能确认 OBS／Zoom 已成功接收</strong>。请分别查看实际预览。</p>
    <p class="hint">手动滑块可直接使用；需要摄像头时，在“摄像头追踪”卡单独点击“开启摄像头追踪”。开始输出不会自动开相机。</p>
    <p class="obs-warning">控制页须为当前可见标签，窗口不最小化。切换标签、最小化或关闭控制页会停止输出，摄像头沿用原后台停止规则；返回后不会自动恢复。</p>
  </section>
</div>
<section class="flow-exit" aria-labelledby="flow-exit-title">
  <h3 id="flow-exit-title"><span class="flow-number">4</span>四种停止分别操作</h3>
  <dl class="flow-stop-list">
    <div><dt>停止输出</dt><dd>本卡“停止输出”：停止参数发布，输出页回默认姿势；不会停止相机、OBS 虚拟摄像机或服务。</dd></div>
    <div><dt>停止摄像头</dt><dd>“摄像头追踪”卡的“停止”：释放相机并停止追踪；不会停止参数发布。</dd></div>
    <div><dt>停止 OBS 虚拟摄像机</dt><dd>在 OBS 点击“停止虚拟摄像机”：停止虚拟摄像机输出；本程序无法确认它的开关状态。</dd></div>
    <div><dt>结束本地服务</dt><dd>在 Node 服务窗口按 Ctrl+C；不会自动关闭 Edge 或 OBS，也不能代替停止相机。</dd></div>
  </dl>
  <p class="flow-exit-order"><strong>完整退出：</strong>停止输出 → 摄像头卡“停止”（若已开）→ OBS“停止虚拟摄像机”（若已开）→ Node 窗口 Ctrl+C。</p>
  <details class="flow-recovery"><summary>暂停、连接中断或服务重启后，怎样恢复？</summary>
    <ol><li>服务已结束：重新双击启动器，使用新打开的控制页（旧控制页须先刷新），等待金色角色加载。OBS 的固定 URL 无需更改；画面未恢复时手动刷新浏览器源。</li><li>保持控制页可见；需要摄像头时单独开启，然后点击“开始输出”。若只暂停输出且相机仍开，直接点击“开始输出”。</li><li>需要 Zoom 本地预览时，在 OBS 手动启动虚拟摄像机，再在 Zoom 选择 OBS Virtual Camera；分别查看实际画面。</li></ol>
    <p>连接中断时先检查 Node 服务窗口。端口占用时程序会报错退出，不会换端口或结束其他进程。重启后相机和输出仍默认关闭；使用新控制页或刷新旧页，再按以上顺序手动恢复。</p>
  </details>
</section>`;
document.querySelector('main').prepend(panel);
const $ = id => document.getElementById(id);
const client = new OutputController({
  readSource: () => ({ready: previewBridge.ready(), identity: outputModelIdentity(), values: previewBridge.values()}),
  onStatus: state => {
    $('output-controller-status').textContent = state.message;
    $('output-start').disabled = !state.ready || state.running || state.busy || document.hidden;
    $('output-stop').disabled = !state.running && !state.busy;
    panel.classList.toggle('is-outputting', state.running);
    if (state.config) {
      // Only the server-provided read URL is exposed, never a token-bearing URL.
      const url = new URL(state.config.outputUrl, location.origin);
      if (url.origin !== location.origin || url.pathname !== '/obs/output' || url.search || url.hash) {
        $('output-copy').disabled = true;
        $('output-preview').removeAttribute('href');
        $('output-preview').setAttribute('aria-disabled', 'true');
        $('output-copy-status').textContent = '输出地址校验失败，请重新启动本地服务。';
      } else {
        $('output-url').value = url.href;
        $('output-copy').disabled = false;
        $('output-preview').href = url.href;
        $('output-preview').setAttribute('aria-disabled', 'false');
      }
    }
  }
});
$('output-start').addEventListener('click', () => { if (!document.hidden) void client.start(); });
$('output-stop').addEventListener('click', () => void client.stop());
$('output-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('output-url').value);
    $('output-copy-status').textContent = '只读输出地址已复制。请粘贴到 OBS 的浏览器源 URL。';
  } catch {
    $('output-url').focus(); $('output-url').select();
    $('output-copy-status').textContent = '浏览器未允许自动复制，地址已选中，请按 Ctrl+C。';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) void client.stop('控制页转到后台，已停止输出。返回后请手动点击“开始输出”。', {abort: true});
  else client.status();
});
for (const id of ['preset', 'folder']) document.getElementById(id)?.addEventListener('change', () => {
  if (client.running || client.starting) void client.stop('模型发生切换，已停止输出。本轮仅支持金色预设；选回后请手动开始。', {abort: true});
}, true);
addEventListener('pagehide', () => { void client.dispose(); });
void client.load();

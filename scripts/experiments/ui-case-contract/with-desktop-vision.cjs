// Run with the installed Electron binary. Decrypt only the selected vision-model
// credential via the same safeStorage mechanism as the desktop app; inject into
// the child environment, never print or persist the plaintext credential.
const { app, safeStorage } = require('electron');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
app.setName('aitest-desktop');
app.setPath('userData', join(app.getPath('appData'), 'aitest-desktop'));
app.dock?.hide();
app.whenReady().then(() => {
  const data = app.getPath('userData');
  const settings = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'));
  const model = settings.models.find(m => m.id === settings.visionModelId);
  if (!model) throw new Error('没有配置视觉模型');
  const encrypted = JSON.parse(readFileSync(join(data, 'secrets.json'), 'utf8'))[`aitest:model:${model.id}`];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) throw new Error('视觉模型凭据不可用');
  const key = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))).authToken;
  if (!key) throw new Error('视觉模型凭据为空');
  // Use the same resolver as the current production source, not a guessed family.
  const root = resolve(__dirname, '../../..');
  import(join(root, 'desktop/dist/main/models.js')).then(({ midsceneEnv }) => {
    const env = { ...process.env, ...midsceneEnv({ agent: model, vision: model }, key) };
    // Explicit experiment-only override, never write back to settings.json.
    if (process.env.CONTRACT_MODEL_FAMILY) {
      if (!['qwen2.5-vl', 'qwen3-vl', 'qwen3'].includes(process.env.CONTRACT_MODEL_FAMILY)) throw new Error('实验模型族不受支持');
      env.MIDSCENE_MODEL_FAMILY = process.env.CONTRACT_MODEL_FAMILY;
    }
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.CONTRACT_NODE || 'node', [join(__dirname, process.env.CONTRACT_FLOW === '1' ? 'run-flow.mjs' : 'run.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Redact before emitting any provider/SDK diagnostic output.
    let pendingOut = '', pendingErr = '';
    const forward = (chunk, stream) => {
      let pending = (stream === 'out' ? pendingOut : pendingErr) + chunk.toString();
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) (stream === 'out' ? process.stdout : process.stderr).write(line.replaceAll(key, '[REDACTED]') + '\n');
      if (stream === 'out') pendingOut = pending; else pendingErr = pending;
    };
    child.stdout.on('data', c => forward(c, 'out'));
    child.stderr.on('data', c => forward(c, 'err'));
    const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 15 * 60_000);
    child.on('error', () => { clearTimeout(timeout); console.error('无法启动实验进程'); app.exit(2); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (pendingOut) process.stdout.write(pendingOut.replaceAll(key, '[REDACTED]'));
      if (pendingErr) process.stderr.write(pendingErr.replaceAll(key, '[REDACTED]'));
      app.exit(code ?? 2);
    });
  }).catch(() => { console.error('无法加载已构建的模型配置解析器，请先构建 desktop main'); app.exit(2); });
}).catch(() => { console.error('视觉模型凭据加载失败；未运行真实模型实验'); app.exit(2); });

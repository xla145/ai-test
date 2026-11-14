/** Synthetic Chinese admin page; no production data or credentials. */
export const manifest = { environment: 'local-fixture', roles: ['fixture-operator'], entries: ['/models'], data: [{ ref: 'fixture-models', key: 'MODEL-UI-001' }] };
const scope = (name) => [{ kind: 'region', name }];
const target = (region, control, extra) => ({ page: '模型管理', scope: scope(region), control, ...extra });

export const tasks = [
  { id: 'search', brief: '搜索模型的输入框', target: target('平台模型', 'textbox', { placeholder: '搜索模型' }), action: 'fill', value: 'MODEL-UI-001', oracle: 'platform-search', result: 'platform-search', kind: 'value', expected: 'MODEL-UI-001' },
  { id: 'switch', brief: '启用故障切换开关', target: target('故障切换配置', 'checkbox', { label: '启用故障切换' }), action: 'check', value: true, oracle: 'fallback-check', result: 'fallback-state', kind: 'text', expected: '故障切换：已启用' },
  { id: 'select', brief: '备用渠道下拉框', target: target('故障切换配置', 'combobox', { label: '备用渠道', name: '备用渠道' }), action: 'click', oracle: 'fallback-select', result: 'fallback-state', kind: 'text', expected: '备用渠道选项：已展开' },
  { id: 'option', brief: '阿里云源选项', target: { ...target('故障切换配置', 'option', { text: '阿里云源' }), scope: [{ kind: 'listbox', name: '故障切换的备用渠道' }] }, action: 'click', oracle: 'fallback-option', result: 'fallback-state', kind: 'text', expected: '备用渠道：阿里云源' },
  { id: 'edit', brief: '编辑按钮', target: { ...target('平台模型', 'button', { text: '编辑' }), scope: [...scope('平台模型'), { kind: 'row', name: '模型记录', key: 'MODEL-UI-001' }] }, action: 'click', oracle: 'edit-target', result: 'platform-state', kind: 'text', expected: '正在编辑：MODEL-UI-001' },
  { id: 'save', brief: '保存按钮', target: target('故障切换配置', 'button', { text: '保存' }), action: 'click', oracle: 'fallback-save', result: 'fallback-state', kind: 'text', expected: '故障切换配置：保存成功' },
];

export function contractFor(task) {
  const expectation = `${task.id}-e1`;
  return {
    version: 'ui-execution/0.1', id: `tc_contract_${task.id}`, title: `本地夹具-${task.id}`,
    source: { caseId: `fixture-${task.id}`, stepIndexes: [1], expectedIds: [expectation] },
    execution: { environment: manifest.environment, role: manifest.roles[0], entry: '/models', data: manifest.data },
    targets: {
      target: task.target,
      result: task.kind === 'value' ? task.target : target(task.result.startsWith('platform') ? '平台模型' : '故障切换配置', 'status', { name: '操作结果' }),
    },
    steps: [{ id: 's1', sourceStep: 1, expectedIds: [expectation], target: 'target', action: task.action, ...(task.value !== undefined ? { value: task.value } : {}), assertions: [{ target: 'result', kind: task.kind, expected: task.expected, evidence: 'dom' }] }],
    coverage: [{ expectedId: expectation, stepIds: ['s1'] }], unresolved: [], status: 'ready',
  };
}

export function fixtureHtml(round = 0, taskId = '') {
  const modelRows = [
    `<tr><td>MODEL-UI-001</td><td>文本模型甲</td><td><button data-testid="edit-target" onclick="result('platform','正在编辑：MODEL-UI-001'); hit('edit-target')">编辑</button></td></tr>`,
    `<tr><td>MODEL-UI-002</td><td>文本模型乙</td><td><button data-testid="edit-other" onclick="result('platform','正在编辑：MODEL-UI-002'); hit('edit-other')">编辑</button></td></tr>`,
  ];
  if (round % 2) modelRows.reverse();
  const select = (prefix, label) => `<div class="el-form-item"><label class="el-form-item__label">备用渠道</label><div class="el-select"><div class="el-select__wrapper" data-testid="${prefix}-wrapper" onclick="document.getElementById('${prefix}-options').hidden=false; result('${prefix}','备用渠道选项：已展开'); hit('${prefix}-select')"><input data-testid="${prefix}-select" role="combobox" aria-label="备用渠道" aria-controls="${prefix}-options" readonly><span class="el-select__selected-item">不设置</span><span class="arrow">▾</span></div></div></div>`;
  const config = (prefix, name) => `<section role="region" aria-label="${name}"><h2>${name}</h2><div class="el-form-item"><label class="el-switch"><input data-testid="${prefix}-check" type="checkbox" onchange="result('${prefix}',this.checked?'故障切换：已启用':'故障切换：已停用'); hit('${prefix}-check')"><span>启用故障切换</span></label></div>${select(prefix, name)}<button data-testid="${prefix}-save" onclick="result('${prefix}','${name}：保存成功'); hit('${prefix}-save')">保存</button><p class="status" role="status" aria-label="操作结果" data-testid="${prefix}-state">待操作</p></section>`;
  const platform = `<section role="region" aria-label="平台模型"><h2>平台模型</h2><input data-testid="platform-search" placeholder="搜索模型" oninput="hit('platform-search')"><table><thead><tr><th>模型编号</th><th>名称</th><th>操作</th></tr></thead><tbody>${modelRows.join('')}</tbody></table><p class="status" role="status" aria-label="操作结果" data-testid="platform-state">待操作</p></section>`;
  const channels = `<section role="region" aria-label="渠道模型"><h2>渠道模型</h2><input data-testid="channel-search" placeholder="搜索模型" oninput="hit('channel-search')"><p>上游模型目录</p><button data-testid="channel-edit" onclick="hit('channel-edit')">编辑</button></section>`;
  const sections = round % 2 ? [platform, channels, config('fallback', '故障切换配置'), config('normal', '普通路由配置')] : [channels, platform, config('normal', '普通路由配置'), config('fallback', '故障切换配置')];
  const options = (prefix, name) => `<div role="listbox" aria-label="${name}" id="${prefix}-options" class="options" style="left:${prefix === 'fallback' ? '660' : '80'}px" ${taskId === 'option' ? '' : 'hidden'}><strong>${name}</strong><button role="option" data-testid="${prefix}-option" onclick="result('${prefix}','备用渠道：阿里云源'); hit('${prefix}-option'); this.parentElement.hidden=true; document.querySelector('[data-testid=${prefix}-wrapper] .el-select__selected-item').textContent='阿里云源'">阿里云源</button><button role="option">本地源</button></div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>模型管理</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#15233b;font:16px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;padding:24px}h1{font-size:24px;margin:0 0 18px}h2{font-size:19px;margin:0 0 18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}section{border:1px solid #cbd5e1;border-radius:8px;background:white;padding:22px;min-height:280px}input:not([type=checkbox]){height:38px;width:260px;padding:6px 10px;border:1px solid #8e9caf;border-radius:4px;font:inherit}input[type=checkbox]{width:24px;height:24px;vertical-align:middle;margin:0 12px 0 0}.el-switch{display:inline-flex;align-items:center;cursor:pointer}.el-form-item{margin:14px 0}.el-form-item__label{display:inline-block;margin-right:16px}.el-select{display:inline-block}.el-select__wrapper{display:inline-block;position:relative;height:38px;width:260px;cursor:pointer}.el-select__selection{position:relative}.el-select__selected-item{position:absolute;left:12px;top:8px;pointer-events:none}.arrow{position:absolute;right:12px;top:8px}button{font:inherit;border:1px solid #aab6c8;border-radius:5px;background:#f7f9fc;padding:7px 20px;cursor:pointer}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{text-align:left;padding:8px;border-bottom:1px solid #e2e8f0}.status{color:#176349;min-height:24px}.options{position:absolute;top:690px;width:330px;background:white;border:2px solid #8396b3;padding:12px;z-index:5;box-shadow:0 4px 14px #33415522}.options strong{display:block;margin-bottom:10px}.options button{margin-right:8px}[hidden]{display:none!important}
  </style></head><body><h1>模型管理</h1><div class="grid">${sections.join('')}</div>${options('normal','普通路由的备用渠道')}${options('fallback','故障切换的备用渠道')}<script>
  window.hits=[];function hit(x){window.hits.push(x)}function result(prefix,text){document.querySelector('[data-testid="'+prefix+'-state"]').textContent=text}
  </script></body></html>`;
}

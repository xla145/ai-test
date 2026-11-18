// Exercise the same public preload API used by AIProbe pages.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = '/Users/mac/rjgf/project/ai-test/outputs/validation-plan-20261117/desktop-native';
const workspace = `${out}/workspace`;
mkdirSync(workspace, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
try {
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://localhost:5173/'));
  if (!page) throw new Error('AIProbe renderer unavailable');
  const invoke = (method, ...args) => page.evaluate(({method, args}) => window.aitest[method](...args), {method, args});
  const name = '湾区智城二期-真实验证';
  let project = (await invoke('listProjects')).find(p => p.name === name && p.workspace_path === workspace);
  if (!project) project = await invoke('createProject', name, workspace, { dev: { base_url: 'https://aicity2.sci-it.com:8098/' } }, { projectType: 'web' });
  if (!project.id) throw new Error('Unexpected createProject result');
  const source = '/Users/mac/rjgf/quchi_need/【产品】湾区智城二期_基础用例导出_20261113 (1).xlsx';
  const first = await invoke('importExcel', project.id, source);
  const second = await invoke('importExcel', project.id, source);
  const cases = await invoke('listCases', project.id);
  const lint = await invoke('lint', project.id);
  const roles = await invoke('listRoles', project.id);
  const role = '超级管理员';
  if (!roles.some(r => r.role_name === role)) await invoke('setRoleSecret', project.id, role, '', '');
  const report = { project, importFirst: first, importSecond: second, count: cases.length, lint, role, status: 'awaiting_native_role_login', businessExecuted: 0 };
  writeFileSync(`${out}/setup.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${out}/cases.json`, JSON.stringify(cases, null, 2));
  if (cases.length !== 206) throw new Error(`Expected 206 cases; got ${cases.length}`);
  await invoke('openRoleLogin', project.id, 'dev', role);
  console.log(JSON.stringify({ projectId: project.id, count: cases.length, first, second, role, loginOpened: true, report: `${out}/setup.json` }));
} finally {
  await browser.close();
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Orchestrator, type EngineCall } from '../src/main/orchestrator.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'execution-tasks-')); dirs.push(dir);
  const taskFile = join(dir, 'tasks.json');
  const engine = vi.fn(async (args: string[]) => args[0] === 'list-projects' ? [{ id: 'p', workspace_path: dir }] : args[0] === 'agent-session' ? { id: 'session' } : {}) as unknown as EngineCall;
  return { engine, taskFile };
}
it('turns unfinished persisted work into a restart failure without replaying it', () => {
  const { engine, taskFile } = setup();
  writeFileSync(taskFile, JSON.stringify([{ id: 'old', status: 'running', source: 'agent' }]));
  const agent = vi.fn();
  const orch = new Orchestrator({ taskFile, engine, agent, secretEnv: () => ({}) });
  expect(orch.uiTasks()[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('PROCESS_RESTARTED') });
  expect(JSON.parse(readFileSync(taskFile, 'utf8'))[0].status).toBe('failed');
  expect(agent).not.toHaveBeenCalled();
});
it('cancels the exact agent and prevents a later successful response from writing a suite', async () => {
  const { engine, taskFile } = setup();
  let finish!: (value: any) => void;
  let ready!: () => void;
  const started = new Promise<void>(r => { ready = r; });
  const orch = new Orchestrator({ taskFile, engine, agent: async () => ({ startThread: async () => 'thread', runTurn: async () => { ready(); return new Promise(resolve => { finish = resolve; }); } }), secretEnv: () => ({}) });
  const pending = orch.generateApiSuite('p', '/openapi.json', true);
  const rejected = expect(pending).rejects.toThrow();
  await started;
  const task = orch.uiTasks()[0];
  expect(orch.recordAgentEvent({ method: 'item/started', params: { item: { type: 'mcpToolCall', server: 'secret', tool: 'wrong' } } })).toBeUndefined();
  expect(orch.recordAgentEvent({ method: 'item/started', params: { threadId: 'other', item: { type: 'mcpToolCall' } } })).toBeUndefined();
  orch.recordAgentEvent({ method: 'item/started', params: { threadId: 'thread', item: { type: 'mcpToolCall', server: 'browser', tool: 'snapshot', arguments: { password: 'never persist' } } } });
  orch.stopExecutionTask(task.id);
  finish({ threadId: 'thread', turnId: 't', status: 'completed', tokens: 12, message: 'late success' });
  await rejected;
  expect(orch.uiTasks()[0].status).toBe('stopped');
  expect((engine as any).mock.calls.some(([args]: any) => args[0] === 'write-api-suite')).toBe(false);
  expect(readFileSync(taskFile, 'utf8')).not.toContain('never persist');
  expect(orch.uiTasks()[0].events).toHaveLength(1);
});

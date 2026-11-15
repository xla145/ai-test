import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from './codegen.js';
import { validateReplayTarget, type LocatorSpec } from './locator.js';

/** Cache selectors, never screen coordinates, refs, credentials or assertion results. */
export class UiBindings {
  private file: string;
  constructor(workspace: string, identity: unknown) {
    this.file = join(workspace, '.aitest', 'ui-bindings', `${sha256(JSON.stringify(identity))}.json`);
  }
  read(): LocatorSpec | undefined {
    try {
      const entry = JSON.parse(readFileSync(this.file, 'utf8'));
      if (entry.version !== 1 || entry.hash !== sha256(JSON.stringify(entry.locator))) return undefined;
      validateReplayTarget(entry.locator);
      return entry.locator;
    } catch { return undefined; }
  }
  save(locator: LocatorSpec) {
    validateReplayTarget(locator);
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, locator, hash: sha256(JSON.stringify(locator)), savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

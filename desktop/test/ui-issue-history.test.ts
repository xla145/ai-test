import {afterEach,expect,it,vi} from 'vitest';
import {readIssue,writeIssue} from '../src/renderer/pages/ui/issueHistory';
afterEach(()=>vi.unstubAllGlobals());
it('persists complete failure text and isolates project, environment and case',()=>{
 const entries=new Map<string,string>();
 vi.stubGlobal('localStorage',{getItem:(k:string)=>entries.get(k),setItem:(k:string,v:string)=>entries.set(k,v)});
 writeIssue('p','dev','c','完整原因\n证据与修复建议');
 expect(readIssue('p','dev','c')?.message).toBe('完整原因\n证据与修复建议');
 expect(readIssue('other','dev','c')).toBeUndefined();
 expect(readIssue('p','prod','c')).toBeUndefined();
 expect(readIssue('p','dev','other')).toBeUndefined();
 writeIssue('p','dev','c','新的失败');
 expect(readIssue('p','dev','c')?.message).toBe('新的失败');
});
it('ignores corrupt records and unavailable storage',()=>{
 vi.stubGlobal('localStorage',{getItem:()=>'{broken'});
 expect(readIssue('p','dev','c')).toBeUndefined();
 vi.stubGlobal('localStorage',{getItem:()=>'{"message":2}',setItem:()=>{throw Error('unavailable');}});
 expect(readIssue('p','dev','c')).toBeUndefined();
 expect(()=>writeIssue('p','dev','c','failure')).not.toThrow();
});

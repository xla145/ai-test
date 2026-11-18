import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserSession} from '../src/ui/browser.js';
import {UI_SERVERS} from '../src/ui/tools.js';

it('reuses persisted structured bindings across sessions only after live DOM validation',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'ui-bindings-'));
 let session=new BrowserSession({headless:true});
 const aiLocate=vi.fn(async()=>{
  const b=(await (await session.page()).getByRole('button',{name:'Save',exact:true}).boundingBox())!;
  return {center:[b.x+b.width/2,b.y+b.height/2]};
 });
 const make=()=>UI_SERVERS.find(s=>s.name==='browser')!.tools({session,
  engine:async()=>({id:'p',name:'demo',workspace_path:workspace,environments:{test:{base_url:'http://sut'}}}),
  secrets:{},vision:async()=>({aiLocate})} as any);
 const target={page:'Settings',scope:[{kind:'region',name:'Settings'}],control:'button',text:'Save'};
 try {
  for(let i=0;i<2;i++){
   const tools=make();
   await tools.find(t=>t.name==='open_project')!.handler({project_id:'p',env:'test'});
   await (await session.page()).setContent('<section role="region" aria-label="Settings"><button>Save</button></section>');
   const result:any=await tools.find(t=>t.name==='ai_locate')!.handler({target});
   expect(result.cache.status).toBe(i?'hit':'miss');
   if(i===0){await session.close();session=new BrowserSession({headless:true});}
  }
  expect(aiLocate).toHaveBeenCalledTimes(1);
  const tools=make();await tools.find(t=>t.name==='open_project')!.handler({project_id:'p',env:'test'});
  await (await session.page()).setContent('<section role="region" aria-label="Settings"><button>Other</button></section>');
  aiLocate.mockImplementationOnce(async()=>({center:[20,20]}));
  await expect(tools.find(t=>t.name==='ai_locate')!.handler({target})).rejects.toThrow();
  expect(aiLocate).toHaveBeenCalledTimes(2);
 }finally{await session.close();rmSync(workspace,{recursive:true,force:true});}
},30000);

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installLocalModels } from '../local-models/install.mjs'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { downloadFile } from '../local-models/download.mjs'
import { fitFor, LocalModels } from '../local-models/manager.mjs'
import { validateRepo, ggufFiles } from '../local-models/catalog.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex')
const root=fileURLToPath(new URL('../../',import.meta.url))
const target=process.platform==='darwin'?'macos-arm64':process.platform==='win32'?'windows-x64':'linux-x64'
let pluginDir=resolve(root,'scripts/local-models')
const app=join(root,'runtimes',target,'dsh')
if(existsSync(join(app,'node_modules'))){const state=join(root,'state',target);await mkdir(state,{recursive:true});installLocalModels(root,app,state);pluginDir=join(app,'node_modules/@portable/local-models')}
const pluginImport=name=>import(pathToFileURL(join(pluginDir,name)).href)
const fixture=()=>mkdtemp(join(tmpdir(),'portable-local-test-'))

test('hardware fit changes when the same USB moves to another machine',()=>{
  assert.equal(fitFor(9*1024**3,{ramGB:8}).fits,false)
  assert.equal(fitFor(9*1024**3,{ramGB:24}).fits,true)
})
test('catalog rejects paths, missing verification metadata and unsupported split/vision files',()=>{
  assert.throws(()=>validateRepo('../file'))
  assert.throws(()=>validateRepo('https://attacker/evil'))
  const f=name=>({rfilename:name,lfs:{size:100,sha256:'a'.repeat(64)}})
  assert.deepEqual(ggufFiles({siblings:[f('model-Q4_K_M.gguf'),f('../outside.gguf'),f('mmproj.gguf'),f('model-00001-of-00003.gguf'),{rfilename:'no-hash.gguf'}]}).map(x=>x.file),['model-Q4_K_M.gguf'])
})
test('download resumes partial bytes, verifies checksum and publishes atomically',async()=>{
  const dir=await fixture();try{const out=join(dir,'model.gguf');const data=Buffer.from('GGUF-model-contents');await writeFile(out+'.part',data.subarray(0,5))
    await downloadFile({url:'https://example.test/model',destination:out,sha256:hash(data),size:data.length,fetcher:async(_url,opts)=>{assert.equal(opts.headers.Range,'bytes=5-');assert.rejects(stat(out));return new Response(data.subarray(5),{status:206,headers:{'content-range':`bytes 5-${data.length-1}/${data.length}`}})}})
    assert.deepEqual(await readFile(out),data);await assert.rejects(stat(out+'.part'))
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('server ignoring range restarts instead of corrupting model',async()=>{
  const dir=await fixture();try{const out=join(dir,'m');const data=Buffer.from('full model');await writeFile(out+'.part','stale')
    await downloadFile({url:'https://example.test/m',destination:out,sha256:hash(data),size:data.length,fetcher:async()=>new Response(data)})
    assert.deepEqual(await readFile(out),data)
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('checksum mismatch never installs a model',async()=>{
  const dir=await fixture();try{const out=join(dir,'m');await assert.rejects(downloadFile({url:'https://example.test/m',destination:out,sha256:'a'.repeat(64),size:3,fetcher:async()=>new Response('bad')}),/Checksum/);await assert.rejects(stat(out));await assert.rejects(stat(out+'.part'))}finally{await rm(dir,{recursive:true,force:true})}
})
test('one download at a time; cancel leaves no installed metadata',async()=>{
  const dir=await fixture();try{const m=new LocalModels(dir,{machine:{target:'macos-arm64',ramGB:16}});await m.init();m.beginJob('test','model',async signal=>{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))});assert.throws(()=>m.beginJob('other','model',async()=>{}),/current operation/);await m.cancel();assert.equal(m.job,null);assert.deepEqual(m.records,[]);await m.close()}finally{await rm(dir,{recursive:true,force:true})}
})
test('restart retains installed metadata; deletion never accepts an arbitrary path',async()=>{
  const dir=await fixture();try{const m=new LocalModels(dir,{machine:{target:'macos-arm64',ramGB:16}});await m.init();const id='1'.repeat(24);await writeFile(join(m.modelsDir,id+'.gguf'),'GGUF');m.records=[{id,name:'Test',size:4,sha256:'a'.repeat(64)}];await m.save();const n=new LocalModels(dir);await n.init();assert.equal(n.records.length,1);await assert.rejects(n.remove('../../outside'),/Unknown/);await n.remove(id);await assert.rejects(stat(join(m.modelsDir,id+'.gguf')))}finally{await rm(dir,{recursive:true,force:true})}
})
test('real Harness adapter discovers local model and translates a streamed tool call',async()=>{
  // Runtime dependencies are supplied by the portable installation / CI setup step.
  const {registerLocalAdapter,providerId}=await pluginImport('adapter.mjs')
  const m=new EventEmitter();m.records=[{id:'test-local',name:'Test GGUF'}];let adapter;let replacements=0
  const ctx={llm:{registerAdapter(ids,a){assert.deepEqual(ids,[providerId]);adapter=a;return {replace(){replacements++}}}},on(){}}
  registerLocalAdapter(ctx,m,'http://127.0.0.1:12345/v1','local-test-key')
  assert.equal((await adapter.listModels(providerId))[0].id,'test-local')
  const resolved=await adapter.resolveModel(providerId,'test-local');assert.ok(resolved)
  const original=globalThis.fetch;let requestBody
  globalThis.fetch=async(_url,options)=>{
    requestBody=JSON.parse(options.body);assert.equal(options.headers.get ? options.headers.get('authorization') : options.headers.Authorization,'Bearer local-test-key')
    const chunks=[{id:'r1',object:'chat.completion.chunk',created:1,model:'test-local',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'read_file',arguments:'{"path":"README.md"}'}}]},finish_reason:null}]},{id:'r1',object:'chat.completion.chunk',created:1,model:'test-local',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}]
    return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})
  }
  try{
    const blocks=[]
    for await(const c of adapter.stream({provider:providerId,model:'test-local',messages:[{role:'user',content:[{type:'text',text:'Read README.md'}]}],tools:[{name:'read_file',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}]}))blocks.push(c)
    assert.ok(requestBody.tools?.length,'tool definitions reach the engine')
    assert.ok(blocks.some(c=>c.type==='block-end'&&c.block?.type==='tool-call'&&c.block.name==='read_file'),'tool call reaches Harness')
  }finally{globalThis.fetch=original}
  m.records.push({id:'second',name:'Second'});m.emit('models');assert.equal((await adapter.listModels(providerId)).length,2);assert.equal(replacements,1)
})

test('local management blocks remote hosts, foreign origins and missing tokens',async()=>{
  const {apply}=await pluginImport('index.mjs');const dir=await fixture();const dispose=[];let handler;let inject
  try{
    const ctx={webServer:{port:3080,register(route){handler=route.handler;return()=>{}}},llm:{registerAdapter(){return{replace(){}}}},on(name,fn){if(name==='webserver/index-inject')inject=fn;if(name==='dispose')dispose.push(fn)}}
    await apply(ctx,{root:dir});const table=[];inject(table);const token=table[0].value.token
    async function request(headers={},address='127.0.0.1'){
      const req={headers:{host:'127.0.0.1:3080',...headers},socket:{remoteAddress:address},method:'GET',url:'/portable-local-models/status'}
      let code,body;const res={writeHead(s){code=s},end(b){body=JSON.parse(b)}};await handler(req,res);return{code,body}
    }
    assert.equal((await request()).code,403)
    assert.equal((await request({'x-local-models-token':token},'192.168.1.1')).code,403)
    assert.equal((await request({'x-local-models-token':token,host:'attacker.example:3080'})).code,403)
    assert.equal((await request({'x-local-models-token':token,origin:'https://evil.example'})).code,403)
    const good=await request({'x-local-models-token':token});assert.equal(good.code,200);assert.ok(good.body.machine.ramGB)
  }finally{for(const d of dispose)await d();await rm(dir,{recursive:true,force:true})}
})
test('client mounts in the native Models slot with accessible catalog controls',async()=>{
  const vm=await import('node:vm');let plugin,component
  const React={createElement:(type,props,...children)=>({type,props,children}),useState:value=>[value,()=>{}],useEffect:()=>{},useRef:value=>({current:value}),Fragment:'fragment'}
  const window={__ModuleLoader__:{load(module){plugin=module.factory(name=>{assert.equal(name,'react');return React})}},__PORTABLE_LOCAL_MODELS__:{base:'/portable-local-models',token:'test'}}
  vm.runInNewContext(await readFile(new URL('../local-models/client.js',import.meta.url),'utf8'),{window,fetch,console})
  plugin.apply({slots:{inject(name,fn){assert.equal(name,'settings.models.footer');fn()},register(spec,c){assert.equal(spec.id,'portable-local-models');component=c}}})
  const tree=JSON.stringify(component());assert.match(tree,/Local models/);assert.match(tree,/Browse models/);assert.match(tree,/For this computer/);assert.match(tree,/aria-label/)
})

test('portable installer declares the plugin in the profile without replacing user configuration',async()=>{
  const {cp}=await import('node:fs/promises');const dir=await fixture()
  try{
    await mkdir(join(dir,'scripts'),{recursive:true});await cp(new URL('../local-models/',import.meta.url),join(dir,'scripts/local-models'),{recursive:true})
    const home=join(dir,'data/dsh-home');const profile=join(home,'profiles/web');await mkdir(profile,{recursive:true})
    const user={name:'custom-web',dependencies:{'some-user-plugin':'1.2.3'},dsh:{profile:{bundles:['user-bundle']}}}
    await writeFile(join(profile,'package.json'),JSON.stringify(user));await writeFile(join(profile,'cordis.patch.yml'),'# user providers must stay unchanged\n')
    installLocalModels(dir,join(dir,'runtime/dsh'),join(dir,'state'),home)
    const saved=JSON.parse(await readFile(join(profile,'package.json'),'utf8'))
    assert.equal(saved.dependencies['some-user-plugin'],'1.2.3');assert.equal(saved.dependencies['@portable/local-models'],'file:../../../../scripts/local-models');assert.deepEqual(saved.dsh,user.dsh)
    assert.equal(await readFile(join(profile,'cordis.patch.yml'),'utf8'),'# user providers must stay unchanged\n')
    assert.ok(existsSync(join(profile,'node_modules/@portable/local-models/client.js')))
  }finally{await rm(dir,{recursive:true,force:true})}
})

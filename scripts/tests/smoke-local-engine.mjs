// Live network / native process acceptance test, run on macOS CI after platform setup.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalModels } from '../local-models/manager.mjs'
const root=await mkdtemp(join(tmpdir(),'portable-engine-smoke-'))
const manager=new LocalModels(root)
try {
  await manager.init()
  const repo='Qwen/Qwen3-0.6B-GGUF'
  const info=await manager.inspect(repo)
  const file=info.files.find(f=>/q4_k_m\.gguf$/i.test(f.file))
  assert.ok(file,'public recommended model has a verified Q4_K_M file')
  await manager.download(repo,file.file);await manager.job.done
  assert.equal(manager.lastError,'');assert.equal(manager.records.length,1)
  await manager.use(manager.records[0].id)
  const response=await fetch(`http://127.0.0.1:${manager.port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.engineKey}`},body:JSON.stringify({model:manager.active,messages:[{role:'user',content:'Say READY.'}],max_tokens:32,temperature:0,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(120000)})
  assert.equal(response.status,200,await response.clone().text());const reply=await response.json();assert.ok(reply.choices[0].message.content)
  const tools=await fetch(`http://127.0.0.1:${manager.port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.engineKey}`},body:JSON.stringify({model:manager.active,messages:[{role:'user',content:'Use read_file to read README.md.'}],tools:[{type:'function',function:{name:'read_file',description:'Read a project file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}],tool_choice:'required',max_tokens:128,temperature:0,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(120000)})
  assert.equal(tools.status,200,await tools.clone().text());const called=await tools.json();assert.equal(called.choices[0].message.tool_calls[0].function.name,'read_file')
  await manager.stop();assert.equal(manager.active,null)
  console.log('Live native engine download, GGUF download, text generation and tool-call smoke passed.')
} finally { await manager.close();await rm(root,{recursive:true,force:true}) }

// Live network / native process acceptance test, run on macOS CI after platform setup.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalModels, machineInfo } from '../local-models/manager.mjs'
const root=await mkdtemp(join(tmpdir(),'portable-engine-smoke-'))
// A tiny fixture model lets CI exercise the 16 GB profile without a large RAM allocation.
const manager=new LocalModels(root,{machine:{...machineInfo(),ramGB:16}})
let lastProgress=0
manager.on('change',()=>{if(Date.now()-lastProgress>10000){lastProgress=Date.now();console.log(JSON.stringify(manager.snapshot().job || {loading:manager.loading,active:manager.active,error:manager.lastError}))}})
try {
  await manager.init()
  const repo='Qwen/Qwen3-0.6B-GGUF'
  const info=await manager.inspect(repo)
  const file=info.files.find(f=>/q4_k_m\.gguf$/i.test(f.file)) || info.files[0]
  assert.ok(file,'public recommended model has a verified single-file GGUF')
  await manager.download(repo,file.file);await manager.job.done
  assert.equal(manager.lastError,'');assert.equal(manager.records.length,1)
  await manager.use(manager.records[0].id)
  const response=await fetch(`http://127.0.0.1:${manager.port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.engineKey}`},body:JSON.stringify({model:manager.active,messages:[{role:'user',content:'Say READY.'}],max_tokens:32,temperature:0,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(120000)})
  assert.equal(response.status,200,await response.clone().text());const reply=await response.json();assert.ok(reply.choices[0].message.content)
  const tools=await fetch(`http://127.0.0.1:${manager.port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.engineKey}`},body:JSON.stringify({model:manager.active,messages:[{role:'user',content:'Use read_file to read README.md.'}],tools:[{type:'function',function:{name:'read_file',description:'Read a project file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}],tool_choice:'required',max_tokens:128,temperature:0,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(120000)})
  assert.equal(tools.status,200,await tools.clone().text());const called=await tools.json();assert.equal(called.choices[0].message.tool_calls[0].function.name,'read_file')
  const longReply=await fetch(`http://127.0.0.1:${manager.port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.engineKey}`},body:JSON.stringify({model:manager.active,messages:[{role:'user',content:'sample '.repeat(8500)+'\nReply READY.'}],max_tokens:32,temperature:0,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(120000)})
  assert.equal(longReply.status,200,await longReply.clone().text());const longResult=await longReply.json()
  assert.ok(longResult.usage.prompt_tokens>8192,'regression prompt exceeds the old context window')
  assert.ok(longResult.choices[0].message.content,'a larger context still produces a response')
  await manager.stop();assert.equal(manager.active,null)
  console.log('Live native engine download, GGUF download, text generation and tool-call smoke passed.')
} finally { await manager.close();await rm(root,{recursive:true,force:true}) }

import { EventEmitter } from 'node:events'
import { readFile, writeFile, mkdir, stat, rm, rename, readdir, chmod, cp } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { totalmem, freemem, cpus, platform, arch } from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { downloadFile } from './download.mjs'
import { recommended, validateRepo, ggufFiles } from './catalog.mjs'
const GiB = 1024 ** 3
export function machineInfo() {
  const target = ({'darwin-arm64':'macos-arm64','linux-x64':'linux-x64','win32-x64':'windows-x64'})[`${platform()}-${arch()}`]
  return { target, platform:platform(), arch:arch(), ramGB: Math.round(totalmem()/GiB), freeGB:Math.round(freemem()/GiB), cpu:cpus()[0]?.model || arch(), acceleration:platform()==='darwin' && arch()==='arm64' ? 'Apple Metal' : 'CPU' }
}
export function fitFor(size, machine = machineInfo()) {
  // 8K context, model working buffers and room for the OS/app; an estimate, not a guarantee.
  const neededGB = Math.ceil(size / GiB * 1.25 + 4)
  return { neededGB, fits:neededGB <= machine.ramGB, note:neededGB <= machine.ramGB ? `Estimated ${neededGB} GB RAM · fits this computer` : `Estimated ${neededGB} GB RAM · larger than this computer` }
}
async function json(url) {
  const r = await fetch(url, {signal:AbortSignal.timeout(30000), headers:{'User-Agent':'DeepSeek-Harness-Portable-Local-Models'}})
  if (!r.ok) throw new Error(`Model catalog returned ${r.status}. This model may require login, a licence agreement, or be unavailable.`)
  return r.json()
}
async function run(command, args) {
  await new Promise((resolve,reject) => {
    const p=spawn(command,args,{stdio:['ignore','ignore','pipe'],windowsHide:true}); let stderr=''
    p.stderr.on('data',c=>{stderr=(stderr+c).slice(-2000)})
    p.once('error',reject);p.once('close',code=>code===0?resolve():reject(new Error(`${command} failed: ${stderr}`)))
  })
}
async function findExecutable(dir) {
  for (const e of await readdir(dir,{withFileTypes:true})) {
    const p=join(dir,e.name)
    if (e.isDirectory()) { const found=await findExecutable(p);if(found)return found }
    else if (/^llama-server(?:\.exe)?$/.test(e.name)) return p
  }
}
async function freePort() {
  const s=createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)})
  const port=s.address().port;await new Promise(r=>s.close(r));return port
}
export class LocalModels extends EventEmitter {
  constructor(root, { machine = machineInfo(), downloader = downloadFile } = {}) {
    super();this.root=root;this.machine=machine;this.downloader=downloader;this.modelsDir=join(root,'models','local');this.runtimeDir=join(root,'runtimes',machine.target || 'unsupported','llama-cpp');this.records=[];this.job=null;this.child=null;this.active=null;this.loading=null;this.inference=0;this.closed=false;this.metadata=new Map();this.lastError=''
    this.engine=JSON.parse(readFileSync(new URL('./engine.json',import.meta.url)))
  }
  async init() {
    await mkdir(this.modelsDir,{recursive:true})
    const saved=JSON.parse(await readFile(join(this.modelsDir,'installed.json'),'utf8').catch(()=>'{"models":[]}'))
    this.records=(saved.models||[]).filter(m=>/^[a-f0-9]{24}$/.test(m.id) && typeof m.size==='number' && /^[a-f0-9]{64}$/.test(m.sha256||'') && existsSync(join(this.modelsDir,`${m.id}.gguf`)))
  }
  snapshot() {
    return {machine:this.machine,supported:!!this.machine.target,models:this.records.map(m=>({...m,fit:fitFor(m.size,this.machine)})),recommended:recommended.map(m=>({...m,fits:m.ramGB<=this.machine.ramGB})).sort((a,b)=>Number(b.fits)-Number(a.fits)),job:this.job ? {id:this.job.id,kind:this.job.kind,...this.job.progress} : null,active:this.active,loading:this.loading,error:this.lastError,inference:this.inference}
  }
  async save() {
    const file=join(this.modelsDir,'installed.json');await writeFile(`${file}.new`,JSON.stringify({models:this.records},null,2));await rename(`${file}.new`,file);this.emit('models');this.emit('change')
  }
  async search(query, offset=0) {
    if (typeof query!=='string'||query.length>100) throw new Error('Enter a shorter search.')
    const list=await json(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=${Math.min(offset+24,120)}`)
    return {items:list.slice(offset,offset+24).map(m=>({repo:m.id,name:m.id,downloads:m.downloads,gated:!!m.gated})),next:list.length>=offset+24 && offset<96 ? offset+24 : null}
  }
  async inspect(repo) {
    validateRepo(repo)
    const info=await json(`https://huggingface.co/api/models/${repo}?blobs=true`)
    if (!/^[a-f0-9]{40}$/.test(info.sha||'')) throw new Error('Catalog did not supply an immutable model revision.')
    const files=ggufFiles(info).map(f=>({...f,fit:fitFor(f.size,this.machine)})).sort((a,b)=>Number(b.fit.fits)-Number(a.fit.fits) || Number(!/q4_k_m/i.test(a.file))-Number(!/q4_k_m/i.test(b.file)) || a.size-b.size)
    const entry={repo,revision:info.sha,files,licence:info.cardData?.license || 'Check model card',url:`https://huggingface.co/${repo}`,note:'Text GGUF files only. Tool calling and architecture support depend on the model. Split files and vision projectors are not supported in this version.'}
    this.metadata.set(repo,entry);return entry
  }
  beginJob(id,kind,work) {
    if (this.closed) throw new Error('Local Models is shutting down.')
    if(this.job || this.loading) throw new Error('Wait for the current operation, or cancel the download first.')
    const controller=new AbortController();const job={id,kind,controller,progress:{phase:'preparing',received:0,total:0}}
    this.job=job;this.lastError='';this.emit('change')
    job.done=(async()=>{try{await work(controller.signal,p=>{job.progress=p;this.emit('change')})}catch(e){if(!controller.signal.aborted)this.lastError=e.message}finally{if(this.job===job)this.job=null;this.emit('change')}})()
  }
  async download(repo,file,allowLarge=false) {
    if(!this.machine.target) throw new Error('This computer is not supported yet.')
    // Re-read trusted metadata, never accept a URL, checksum or local path from the browser.
    const info=await this.inspect(repo);const entry=info.files.find(f=>f.file===file)
    if(!entry)throw new Error('Choose a supported GGUF file from the model catalog.')
    if(!entry.fit.fits&&!allowLarge)throw new Error('This model exceeds the estimated RAM budget. Choose a smaller quantization, or explicitly allow the larger download.')
    const id=createHash('sha256').update(`${repo}/${info.revision}/${file}`).digest('hex').slice(0,24)
    if(this.records.some(m=>m.id===id))return
    this.beginJob(id,'model',async(signal,progress)=>{
      await this.downloader({url:`https://huggingface.co/${repo}/resolve/${info.revision}/${file}`,destination:join(this.modelsDir,`${id}.gguf`),sha256:entry.sha256,size:entry.size,signal,progress})
      this.records.push({id,repo,file,revision:info.revision,size:entry.size,sha256:entry.sha256,name:`${repo.split('/')[1]} · ${file.split('/').pop().replace(/\.gguf$/i,'')}`});await this.save()
    })
  }
  async cancel() {const job=this.job;if(job){job.controller.abort();await job.done}}
  async ensureEngine(signal,progress) {
    const marker=join(this.runtimeDir,'installed.json');let previous
    try{previous=JSON.parse(await readFile(marker,'utf8'))}catch{}
    if(previous?.version===this.engine.version) { const exe=await findExecutable(this.runtimeDir);if(exe)return exe }
    const asset=this.engine.targets[this.machine.target];if(!asset)throw new Error('No engine is available for this computer.')
    await mkdir(this.runtimeDir,{recursive:true})
    const archive=join(this.runtimeDir,asset.url.endsWith('.zip')?'engine.zip':'engine.tar.gz')
    await this.downloader({...asset,destination:archive,signal,progress})
    signal?.throwIfAborted()
    const stage=join(this.runtimeDir,'extract');await rm(stage,{recursive:true,force:true});await mkdir(stage)
    if(this.machine.target==='windows-x64') {
      // Values are app-owned paths, escaped for PowerShell single-quoted literals.
      const quote=p=>`'${p.replace(/'/g,"''")}'`
      await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(stage)} -Force`])
    } else await run('/usr/bin/tar',['-xzf',archive,'-C',stage])
    // Dereference archive symlinks for exFAT portability; preserve adjacent dynamic libraries.
    const payload=join(this.runtimeDir,'bin');await rm(payload,{recursive:true,force:true});await cp(stage,payload,{recursive:true,dereference:true})
    await rm(stage,{recursive:true,force:true});const exe=await findExecutable(payload)
    if(!exe)throw new Error('The downloaded engine did not contain llama-server.')
    if(this.machine.target!=='windows-x64')await chmod(exe,0o755)
    await writeFile(marker,JSON.stringify({version:this.engine.version}));await rm(archive,{force:true});return exe
  }
  async use(id,allowLarge=false) {
    if(this.job||this.loading||this.inference)throw new Error('Wait for the current operation to finish.')
    const m=this.records.find(x=>x.id===id);if(!m)throw new Error('Download this model first.')
    if(!fitFor(m.size,this.machine).fits&&!allowLarge)throw new Error('This model exceeds this computer’s estimated RAM budget.')
    this.beginJob(id,'engine',async(signal,progress)=>{this.executable=await this.ensureEngine(signal,progress);signal.throwIfAborted()})
    await this.job.done
    if(this.lastError)throw new Error(this.lastError)
    if(!this.executable)throw new Error('Engine setup was cancelled.')
    await this.start(id)
  }
  async start(id) {
    if(this.closed)throw new Error('Local Models is shutting down.')
    if(this.active===id&&this.child)return
    if(this.loading||this.inference)throw new Error('Another local model is busy. Wait for it to finish.')
    const m=this.records.find(x=>x.id===id);if(!m)throw new Error('Download this model in Settings → Models first.')
    if(!fitFor(m.size,this.machine).fits)throw new Error('This model exceeds this computer’s estimated RAM budget. Choose a smaller model.')
    this.loading=id;this.lastError='';this.emit('change')
    try {
      await this.stopChild()
      const exe=this.executable || (existsSync(join(this.runtimeDir,'installed.json')) ? await findExecutable(join(this.runtimeDir,'bin')) : null)
      if(!exe)throw new Error('Click Use model in Settings → Models to install the local engine first.')
      const port=await freePort();this.port=port;this.engineKey=randomBytes(24).toString('hex')
      const args=['--model',join(this.modelsDir,`${id}.gguf`),'--alias',id,'--host','127.0.0.1','--port',String(port),'--ctx-size','8192','--parallel','1','--jinja','--api-key',this.engineKey,'--no-webui','--n-gpu-layers',this.machine.acceleration==='Apple Metal'?'99':'0']
      const child=spawn(exe,args,{cwd:dirname(exe),stdio:['ignore','pipe','pipe'],windowsHide:true});this.child=child;let tail='';let failure
      const capture=c=>{tail=(tail+c).slice(-5000)};child.stdout.on('data',capture);child.stderr.on('data',capture)
      child.once('error',e=>{failure=e});child.once('exit',code=>{if(this.child===child){this.child=null;this.active=null;if(code && !this.closed)this.lastError=`Local engine exited (${code}). ${tail.slice(-1000)}`;this.emit('change')}})
      const deadline=Date.now()+180000
      while(Date.now()<deadline) {
        if(failure||child.exitCode!==null||this.closed)throw failure || new Error(`Local engine could not load the model. ${tail.slice(-1500)}`)
        try{const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1500)});if(r.ok){this.active=id;return}}catch{}
        await delay(500)
      }
      throw new Error('Model loading timed out. Try a smaller model or free some memory.')
    } catch(e){this.lastError=e.message;await this.stopChild();throw e}finally{this.loading=null;this.emit('change')}
  }
  async stopChild() {
    const child=this.child;if(!child)return
    this.child=null;this.active=null
    child.kill('SIGTERM')
    await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)])
    if(child.exitCode===null)child.kill('SIGKILL')
  }
  async stop() {if(this.loading||this.inference)throw new Error('Wait for the active local request to finish.');await this.stopChild();this.emit('change')}
  async remove(id) {
    if(this.job||this.loading||this.inference)throw new Error('Wait for the current operation to finish.')
    if(!this.records.some(m=>m.id===id))throw new Error('Unknown model.')
    if(this.active===id)await this.stop()
    await rm(join(this.modelsDir,`${id}.gguf`),{force:true});this.records=this.records.filter(m=>m.id!==id);await this.save()
  }
  async close(){this.closed=true;await this.cancel();await this.stopChild()}
}

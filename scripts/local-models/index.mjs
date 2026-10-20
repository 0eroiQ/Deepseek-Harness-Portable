import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { LocalModels } from './manager.mjs'
import { registerLocalAdapter } from './adapter.mjs'
export const name='portable-local-models'
export const inject=['webServer','llm']
export function respond(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
export async function readBody(req,limit=16384){let size=0;const parts=[];for await(const c of req){size+=c.length;if(size>limit)throw new Error('Request too large.');parts.push(c)}return JSON.parse(Buffer.concat(parts).toString()||'{}')}
export function localRequest(req,port){
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && [`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(req.headers.host)
    && (!req.headers.origin || req.headers.origin===`http://${req.headers.host}`)
}
export async function apply(ctx,config={}) {
  const root=config.root || process.env.DSH_PORTABLE_ROOT
  if(!root)throw new Error('Local Models must be started with the portable launcher.')
  const manager=new LocalModels(root);await manager.init()
  const port=ctx.webServer.port;const token=randomBytes(32).toString('hex');const engineToken=randomBytes(32).toString('hex')
  const base='/portable-local-models'
  let inferenceBusy=false
  registerLocalAdapter(ctx,manager,`http://127.0.0.1:${port}${base}/v1`,engineToken)
  ctx.on('webserver/index-inject',table=>table.push({kind:'global',name:'__PORTABLE_LOCAL_MODELS__',value:{base,token}}))
  const dispose=ctx.webServer.register({kind:'prefix',path:base,handler:async(req,res)=>{
    try{
      if(!localRequest(req,port))return respond(res,403,{error:'Local Models is available only on this computer.'})
      const path=new URL(req.url,`http://127.0.0.1:${port}`).pathname.slice(base.length)
      const inference=path==='/v1/chat/completions'
      const supplied=inference ? req.headers.authorization : req.headers['x-local-models-token']
      if(supplied!==(inference?`Bearer ${engineToken}`:token))return respond(res,403,{error:'Reload the app to reconnect to Local Models.'})
      if(inference){
        if(req.method!=='POST')return respond(res,405,{error:'POST required.'})
        const body=await readBody(req,32*1024*1024)
        if(inferenceBusy || manager.job)throw new Error('The local engine is busy. Wait for the current operation.')
        inferenceBusy=true
        const controller=new AbortController();const disconnected=()=>{if(!res.writableEnded)controller.abort()};res.once('close',disconnected)
        let started=false
        try{
          await manager.start(body.model);manager.inference++;started=true;manager.emit('change')
          controller.signal.throwIfAborted()
          // Keep memory use bounded and disable thinking for predictable small-model agent tests.
          body.max_tokens=Math.min(Number(body.max_tokens||2048),2048);delete body.max_completion_tokens
          body.chat_template_kwargs={enable_thinking:false}
          const upstream=await fetch(`http://127.0.0.1:${manager.port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.engineKey}`},body:JSON.stringify(body),signal:controller.signal})
          res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json','Cache-Control':'no-store'})
          if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),res)
          else res.end()
        }finally{res.off('close',disconnected);if(started)manager.inference--;inferenceBusy=false;manager.emit('change')}
        return
      }
      if(path==='/status'&&req.method==='GET')return respond(res,200,manager.snapshot())
      if(req.method!=='POST')return respond(res,405,{error:'POST required.'})
      const body=await readBody(req)
      if(path==='/search')return respond(res,200,await manager.search(body.query||'',Math.max(0,Math.min(Number(body.offset)||0,96))))
      if(path==='/inspect')return respond(res,200,await manager.inspect(body.repo))
      if(path==='/download')await manager.download(body.repo,body.file,body.allowLarge===true)
      else if(path==='/cancel')await manager.cancel()
      else if(path==='/use'){// Do not hold the HTTP request while a model loads; status reports progress/errors.
        manager.use(body.id).catch(e=>{manager.lastError=e.message;manager.emit('change')})
      }
      else if(path==='/stop')await manager.stop()
      else if(path==='/remove')await manager.remove(body.id)
      else return respond(res,404,{error:'Unknown Local Models action.'})
      respond(res,200,manager.snapshot())
    }catch(e){if(!res.headersSent)respond(res,400,{error:e.message});else res.destroy()}
  }})
  const onExit=()=>manager.child?.kill('SIGTERM');process.once('exit',onExit)
  ctx.on('dispose',async()=>{dispose();process.off('exit',onExit);await manager.close()})
}

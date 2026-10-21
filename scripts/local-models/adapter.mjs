import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { inferenceLimits } from './limits.mjs'
export const providerId='portable-local'
// Reuse Harness's existing protocol/replay/tool-call implementation. Only model storage and engine lifecycle are new.
export function registerLocalAdapter(ctx,manager,baseURL,key) {
  let profiles=new Map();let registration
  const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>key,
    auth:{credentials:{get:()=>undefined,set:()=>{},delete:()=>{},list:()=>[]},authContext:{getEnv:()=>undefined,readFile:async()=>undefined}}})
  const refresh=()=>{
    const api=openAICompletionsApi()
    const models=manager.records.map(m=>({id:m.id,name:`${m.name} · Local`,api:'openai-completions',provider:providerId,baseUrl:baseURL,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},...inferenceLimits(manager.machine),compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false,maxTokensField:'max_tokens'}}))
    const piProvider={id:providerId,name:'Local models',baseUrl:baseURL,auth:{apiKey:{name:'Managed local engine',resolve:async()=>({auth:{apiKey:key},source:'Managed local engine'})}},getModels:()=>models,
      stream:(model,context,options)=>api.stream(model,context,options),streamSimple:(model,context,options)=>api.streamSimple(model,context,options)}
    profiles=new Map([[providerId,{provider:providerId,displayName:'Local models',api:'openai-completions',baseURL,streamIdleTimeoutMs:300000,maxRequestImageBytes:20971520,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576,retryPolicy:resolveRetryPolicy({mode:'normal',maxRetries:0},'local models'),configuredMaxTokens:new Map(models.map(m=>[m.id,m.maxTokens])),modelErrors:new Map(),piProvider}]])
    if(!registration)registration=ctx.llm.registerAdapter([providerId],adapter)
    else registration.replace([providerId])
  }
  refresh();manager.on('models',refresh)
  ctx.on('dispose',()=>manager.off('models',refresh))
  return adapter
}

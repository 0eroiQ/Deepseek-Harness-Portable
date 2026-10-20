import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installLocalModels } from '../local-models/install.mjs'
const root=process.cwd();const target='macos-arm64';const app=join(root,'runtimes',target,'dsh');const output=join(root,'temp','ui-artifacts');await mkdir(output,{recursive:true})
const overlay=installLocalModels(root,app,join(root,'state',target))
const child=spawn(process.execPath,[join(app,'node_modules','@deepseek-ai','dsh','lib','bin.js'),'web','--patch',overlay,'--no-open','--port','0'],{env:{...process.env,DSH_HOME:join(root,'temp','ui-smoke-home')},stdio:['ignore','pipe','pipe']})
let logs='';let readyResolve,readyReject;const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j})
const timer=setTimeout(()=>readyReject(new Error('Web startup timed out: '+logs.slice(-3000))),60000)
const capture=c=>{logs+=c.toString();const m=logs.match(/dsh web: (http:\/\/[^\s]+)/);if(m)readyResolve(m[1])};child.stdout.on('data',capture);child.stderr.on('data',capture);child.on('error',readyReject);child.on('exit',code=>readyReject(new Error('Web process exited '+code+': '+logs.slice(-3000))))
let browser
try{
  const url=await ready;clearTimeout(timer)
  const {chromium}=await import(pathToFileURL(resolve('temp/ui-tools/node_modules/playwright/index.mjs')).href)
  browser=await chromium.launch({channel:'chrome',headless:true})
  const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(url);await page.getByRole('button',{name:'Continue',exact:true}).click({timeout:20000})
  const settings=page.getByRole('button',{name:'Settings',exact:true}).or(page.getByRole('link',{name:'Settings',exact:true}))
  await settings.first().click();await page.getByRole('button',{name:'Models',exact:true}).click()
  const local=page.getByRole('region',{name:'Local models'});await local.waitFor({timeout:20000})
  await local.getByRole('button',{name:'For this computer',exact:true}).click()
  await local.getByText('Qwen3 · 4B',{exact:true}).waitFor({timeout:20000})
  assert.equal(await local.getByRole('button',{name:'Browse models',exact:true}).count(),1)
  await local.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'local-models.png'),fullPage:true})
  assert.equal(errors.length,0,errors.join('\n'))
  console.log('Native browser Local Models screen rendered successfully.')
} catch(e){await writeFile(join(output,'error.txt'),String(e)+'\n'+logs);if(browser){const pages=browser.contexts().flatMap(c=>c.pages());if(pages[0]){await writeFile(join(output,'page.txt'),await pages[0].locator('body').innerText());await pages[0].screenshot({path:join(output,'failure.png'),fullPage:true})}}throw e}
finally{clearTimeout(timer);await browser?.close();child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),4000).unref()}

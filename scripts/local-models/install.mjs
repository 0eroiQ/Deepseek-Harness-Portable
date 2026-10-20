import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
// Copy, not symlink: USB exFAT and the portable runtime installer both require this.
export function installLocalModels(root,app,state,dshHome=join(root,'data','dsh-home')) {
  const source=join(root,'scripts','local-models')
  const runtimePackage=join(app,'node_modules','@portable','local-models')
  mkdirSync(runtimePackage,{recursive:true});cpSync(source,runtimePackage,{recursive:true})
  // Harness only exposes declared packages to its module loader. Register this
  // out-of-tree plugin in the profile, preserving every user dependency/bundle.
  const profile=join(dshHome,'profiles','web')
  const destination=join(profile,'node_modules','@portable','local-models')
  mkdirSync(destination,{recursive:true});cpSync(source,destination,{recursive:true})
  const packageFile=join(profile,'package.json')
  const manifest=existsSync(packageFile)?JSON.parse(readFileSync(packageFile,'utf8')):{name:'dsh-profile-web',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}
  const spec='file:'+relative(profile,source).replaceAll('\\','/')
  if(manifest.dependencies?.['@portable/local-models']!==spec){manifest.dependencies={...manifest.dependencies,'@portable/local-models':spec};writeFileSync(packageFile,JSON.stringify(manifest,null,2)+'\n')}
  mkdirSync(state,{recursive:true})
  const overlay=join(state,'local-models.patch.yml')
  writeFileSync(overlay,JSON.stringify([{id:'ui-settings-models',config:{credentialOnboarding:false}},{insert:[{id:'portable-local-models',name:'@portable/local-models',config:{root}}]}],null,2))
  return overlay
}

import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Copy, not symlink: USB exFAT and the portable runtime installer both require this.
export function installLocalModels(root,app,state) {
  const destination=join(app,'node_modules','@portable','local-models')
  mkdirSync(destination,{recursive:true})
  cpSync(join(root,'scripts','local-models'),destination,{recursive:true})
  const overlay=join(state,'local-models.patch.yml')
  writeFileSync(overlay,JSON.stringify([{insert:[{id:'portable-local-models',name:'@portable/local-models',config:{root}}]}],null,2))
  return overlay
}

// Only the recommended shelf is curated. Search browses public Hugging Face GGUF repositories.
export const recommended = [
  { repo: 'Qwen/Qwen3-0.6B-GGUF', name: 'Qwen3 · 0.6B', description: 'Small download for testing the connection. Limited reasoning and tool reliability.', ramGB: 4 },
  { repo: 'Qwen/Qwen3-4B-GGUF', name: 'Qwen3 · 4B', description: 'A practical starting point for local agents on a laptop.', ramGB: 8 },
  { repo: 'Qwen/Qwen3-8B-GGUF', name: 'Qwen3 · 8B', description: 'More capable, with higher memory use.', ramGB: 12 },
  { repo: 'Qwen/Qwen3-14B-GGUF', name: 'Qwen3 · 14B', description: 'Larger model for computers with more memory.', ramGB: 20 },
]
export function validateRepo(repo) {
  if (typeof repo !== 'string' || (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(x => x === '.' || x === '..'))) throw new Error('Choose a valid Hugging Face repository.')
  return repo
}
export function ggufFiles(info) {
  return (info.siblings || []).filter(f => /\.gguf$/i.test(f.rfilename)
    && !/mmproj|vision|encoder/i.test(f.rfilename)
    && !/-\d{5}-of-\d{5}\.gguf$/i.test(f.rfilename)
    && /^[\w./-]+$/.test(f.rfilename) && !f.rfilename.split('/').includes('..'))
    .map(f => ({ file: f.rfilename, size: f.lfs?.size || f.size, sha256: f.lfs?.sha256 }))
    .filter(f => Number.isSafeInteger(f.size) && f.size > 0 && /^[a-f0-9]{64}$/.test(f.sha256 || ''))
    .sort((a,b) => Number(!/q4_k_m/i.test(a.file)) - Number(!/q4_k_m/i.test(b.file)) || a.size - b.size)
}

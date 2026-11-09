// A stand-in for the podvision binary in core's tests (#191): `node fakePodvision.mjs <mode> <podvision args>`.
// ok: every pod "sprouted" at 0.6 for every model, with the model file's version; damaged, fail, hang, garbage, flood, short: what they say.
import { readFileSync } from 'node:fs'
import { getPriority } from 'node:os'

const [mode, ...args] = process.argv.slice(2)
const arg = name => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))

const chunks = []
for await (const c of process.stdin) chunks.push(c)
const bytes = Buffer.concat(chunks)

if (mode === 'hang') setInterval(() => {}, 1000)
else if (mode === 'fail') {
  process.stderr.write('podvision: bad JPEG: unexpected EOF\n')
  process.exit(4)
}
else if (mode === 'garbage') process.stdout.write('not json\n')
else if (mode === 'flood') process.stdout.write('x'.repeat(5 << 20))
else {
  const regions = JSON.parse(arg('--regions')[0])
  const models = arg('--model').map(p => JSON.parse(readFileSync(p, 'utf8')))
  const probabilities = mode === 'short' ? [1] : [0.1, 0.6, 0.1, 0.1, 0.1]
  process.stdout.write(`${JSON.stringify({
    width: 320,
    height: 240,
    decoded: { width: 320, height: 240, eighths: 8 },
    damaged: mode === 'damaged',
    brightness: 0.4,
    nice: getPriority(),
    stdinBytes: bytes.length,
    models: mode === 'damaged' ? [] : models.map(m => ({ analyzer: m.analyzer, version: m.version, revision: m.revision, skipped: null, pods: Object.keys(regions).map(Number).map(slot => ({ slot, class: 1, probabilities })) })),
    timing: { decodeMs: 1, forwardMs: 1, totalMs: 2 },
  })}\n`)
}

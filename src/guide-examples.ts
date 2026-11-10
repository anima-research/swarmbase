/** Worked examples shown at the end of the guide. Each one runs as written:
 *  test/guide.test.ts executes them with stub agents. Keep them short and keep a
 *  "Fits:" line first, so a reader knows when the shape applies. */
export const GUIDE_EXAMPLES: { title: string; code: string }[] = [
  {
    title: "Read many files, check each, synthesize",
    code: `// Fits: one independent read per file, a check of each summary against its file, then one synthesis.
// args: { dir: '/abs/notes', files: ['a.md', 'b.md'] }
export const meta = { name: 'survey-notes', description: 'Summarize each file, check each summary against it, synthesize' }
phase('Read')
const files = args.files
const notes = await pipeline(files,
  f => agent(\`Read \${f} and summarize its argument in 5 bullets.\`, { label: f, phase: 'Read', profile: 'read', cwd: args.dir }),
  (summary, f) => summary && agent(\`Read \${f}, then rate this summary of it for fidelity 1-5 and say why:\\n\${summary}\`,
    { label: 'check ' + f, phase: 'Check', profile: 'read', cwd: args.dir, model: 'haiku',
      schema: { type: 'object', properties: { score: { type: 'integer' }, why: { type: 'string' } }, required: ['score', 'why'] } })
      .then(v => ({ f, summary, v })))
phase('Synthesize')
const good = notes.filter(Boolean).filter(n => n.v && n.v.score >= 4)
const leftOut = files.filter(f => !good.some(n => n.f === f))
log(\`\${good.length}/\${files.length} summaries passed the check\`)
if (!good.length) return { page: null, leftOut }
const page = await agent('Synthesize these summaries into one page:\\n' + good.map(n => n.f + ':\\n' + n.summary).join('\\n\\n'), { profile: 'think' })
  .catch(e => { log(\`synthesis: \${e.message}\`); return null })  // keep the summaries if the last step fails
return page ? { page, leftOut } : { page: null, summaries: good.map(n => ({ file: n.f, summary: n.summary })), leftOut }
`,
  },
  {
    title: "Review: find, then try to refute",
    code: `// Fits: checking a branch's changes for bugs, where a false alarm costs your reader's time.
// args: { dir: '/abs/repo', files: ['src/a.ts', 'src/b.ts'], diffs: { 'src/a.ts': '…' } }
// Scout first: run \`git diff\` yourself and pass each file's diff. Read agents on the claude engine have no shell.
export const meta = { name: 'review', description: 'Find bugs per changed file, then try to refute each one' }
const BUGS = { type: 'object', required: ['bugs'], properties: { bugs: { type: 'array', items: {
  type: 'object', required: ['file', 'line', 'claim'],
  properties: { file: { type: 'string' }, line: { type: 'integer' }, claim: { type: 'string' } } } } } }
const VERDICT = { type: 'object', required: ['refuted', 'why'],
  properties: { refuted: { type: 'boolean' }, why: { type: 'string' } } }

phase('Find')
const found = await parallel(args.files.map(f => () => agent(
  \`A branch changes \${f} in \${args.dir}. Its diff:\\n\${args.diffs?.[f] ?? '(no diff given: review the whole file)'}\\n\\n\` +
  \`Review the change for correctness bugs: wrong results, crashes, lost data. Read the rest of the file, and the \` +
  \`files it calls, for context. Ignore style. For each bug give the file, the line and one sentence a reader could \` +
  \`check against the code. Return an empty list if you find none.\`,
  { label: f, phase: 'Find', profile: 'read', cwd: args.dir, schema: BUGS })))
const failedFiles = args.files.filter((f, i) => !found[i])
// A barrier on purpose: drop exact repeats, and skip verification entirely when there are none.
const seen = new Set()
const bugs = found.filter(Boolean).flatMap(r => r.bugs).filter(b => {
  const key = b.file + ':' + b.line + ':' + b.claim
  if (seen.has(key)) return false
  seen.add(key)
  return true
})
log(\`\${bugs.length} distinct candidates; \${failedFiles.length} of \${args.files.length} files were not reviewed\`)
if (!bugs.length) return { bugs: [], refuted: [], unverified: [], failedFiles }

phase('Verify')
const judged = await parallel(bugs.map(b => async () => {
  const votes = (await parallel([1, 2, 3].map(i => () => agent(
    \`Someone claims there is a bug at \${b.file}:\${b.line} in \${args.dir}: "\${b.claim}". \` +
    \`Read the code and try to show the claim is wrong. If the code does not clearly confirm it, answer refuted: true.\`,
    { label: \`refute \${b.file}:\${b.line} #\${i}\`, phase: 'Verify', profile: 'read', cwd: args.dir, schema: VERDICT })))).filter(Boolean)
  return { ...b, votes: votes.length, upheld: votes.filter(v => !v.refuted).length }
}))
// Two of three skeptics decide either way; with too few votes back, a candidate was never checked.
const kept = judged.filter(b => b.upheld >= 2)
const refuted = judged.filter(b => b.votes - b.upheld >= 2)
const unverified = judged.filter(b => b.upheld < 2 && b.votes - b.upheld < 2)
log(\`\${kept.length} kept, \${refuted.length} refuted, \${unverified.length} unverified\`)
return { bugs: kept, refuted, unverified, failedFiles }
`,
  },
  {
    title: "Research: sweep several ways, read, synthesize, ask what is missing",
    code: `// Fits: a question whose answer is spread across sources that no single search finds.
// args: { question: '...' }
export const meta = { name: 'research', description: 'Search several ways, read each source, synthesize, ask what is missing' }
const SOURCES = { type: 'object', required: ['sources'], properties: { sources: { type: 'array', items: {
  type: 'object', required: ['url', 'adds'], properties: { url: { type: 'string' }, adds: { type: 'string' } } } } } }
const ANGLES = ['primary documents and official statements', 'recent reporting', 'technical or academic writing', 'critics and dissenting views']

phase('Sweep')
const lists = await parallel(ANGLES.map(a => () => agent(
  \`Research question: \${args.question}\\nSearch the web for \${a} on this question. Return up to 6 sources you actually \` +
  \`opened, each with its URL and one line on what it adds.\`,
  { label: a, phase: 'Sweep', profile: 'read', schema: SOURCES })))
// A barrier on purpose: the same source turns up under several angles.
const sources = [...new Map(lists.filter(Boolean).flatMap(l => l.sources).map(s => [s.url, s])).values()]
const anglesFailed = ANGLES.filter((a, i) => !lists[i])
log(\`\${sources.length} distinct sources; \${anglesFailed.length} of \${ANGLES.length} angles failed\`)

phase('Read')
const notes = (await parallel(sources.map(s => () => agent(
  \`Read \${s.url} and extract what it says about: \${args.question}\\nQuote the key sentences exactly, give the date, \` +
  \`and say how reliable the source looks and why. Return plain text.\`,
  { label: s.url.slice(0, 60), phase: 'Read', profile: 'read' }).then(t => t && { url: s.url, notes: t })))).filter(Boolean)

phase('Synthesize')
// agent() throws once the budget is spent: catch the last stages so the notes are not lost.
const answer = await agent(
  \`Question: \${args.question}\\nUsing only the notes below, write a cited answer (cite by URL) and mark every point \` +
  \`where the sources disagree.\\n\\n\` + notes.map(n => \`## \${n.url}\\n\${n.notes}\`).join('\\n\\n'),
  { label: 'synthesis', phase: 'Synthesize', profile: 'think' }).catch(e => { log(\`synthesis: \${e.message}\`); return null })
const unread = sources.filter(s => !notes.some(n => n.url === s.url)).map(s => s.url)
if (!answer) return { answer: null, notes, unread, anglesFailed }
// The critic's list is the brief for your next run, not something to bolt on here.
const gaps = await agent(
  \`Here is an answer to "\${args.question}":\\n\\n\${answer}\\n\\nWhat is missing or unsupported: a claim with no source, \` +
  \`an angle nobody searched, a source that should have been read? Return a short list, or "none".\`,
  { label: 'critic', phase: 'Synthesize', profile: 'think' }).catch(e => \`critic did not run: \${e.message}\`)
return { answer, gaps, sourcesRead: notes.length, unread, anglesFailed }
`,
  },
  {
    title: "Decide: independent proposals, one judge",
    code: `// Fits: a design or decision with several reasonable answers.
// args: { problem: '...', context: 'what you already know, the constraints, what was ruled out' }
export const meta = { name: 'decide', description: 'Independent proposals from different angles, then one judge' }
const ANGLES = ['the simplest thing that could work', 'what breaks first under load or misuse', 'what the people using it will notice']

phase('Propose')
const proposals = (await parallel(ANGLES.map((a, i) => () => agent(
  \`Problem: \${args.problem}\\nContext: \${args.context}\\nPropose one approach, optimizing for \${a}. Give the approach, \` +
  \`its main risk, and what would change your mind. Under 400 words.\`,
  { label: 'angle ' + (i + 1), phase: 'Propose', profile: 'think' })))).filter(Boolean)
log(\`\${proposals.length} of \${ANGLES.length} proposals came back\`)

phase('Judge')
const verdict = await agent(
  \`Problem: \${args.problem}\\nContext: \${args.context}\\n\\n\` +
  proposals.map((p, i) => \`### Proposal \${i + 1}\\n\${p}\`).join('\\n\\n') +
  \`\\n\\nScore each proposal 1-10 against the problem, pick the strongest, and improve it with anything better \` +
  \`from the others. Return the recommendation first, then one line per score.\`,
  { label: 'judge', phase: 'Judge', profile: 'think', effort: 'high' })
  .catch(e => { log(\`judge: \${e.message}\`); return null })  // the proposals are still worth returning
return { verdict, proposals }
`,
  },
];

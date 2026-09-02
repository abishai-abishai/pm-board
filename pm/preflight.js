#!/usr/bin/env node
/**
 * pm/preflight.js — main 에 머지하기 전에 무엇이 나가는지 본다.
 *
 *   node pm/preflight.js           지금 상태로 점검한다
 *   node pm/preflight.js --fetch   원격을 먼저 받아 온 뒤 점검한다
 *
 * ⚠️ 이 도구는 아무것도 고치지 않는다. 읽고 보여주기만 한다.
 *
 * 왜 만들었나 (2026-09-01 결정 사항)
 *
 *   그전에는 배포를 PO 세션이 전담했다. "지금 나가도 되는가" 를 판단할 근거가
 *   그 세션에만 있다고 봤기 때문이다. 이제 그 근거는 칸반 데이터에 있다 —
 *   릴리즈 대기 칸에 선 일감이 곧 검증까지 끝난 것이다.
 *   그래서 PO 와 PM 이 배포를 나눠 맡기로 했고(docs/기능정의서.md), 누가 하든
 *   같은 것을 보도록 점검을 사람 기억에서 스크립트로 옮겼다.
 *
 * ⚠️ 이 점검은 머지를 막지 않는다. 종료 코드는 늘 0 이다.
 *
 *    feature 는 네 세션이 함께 쓴다. 머지하면 그 시점의 모든 커밋이 같이 나가고
 *    내 것만 골라낼 수 없다. 그래서 **아직 검증 안 끝난 커밋이 섞이는 일은 늘 있다.**
 *    막으면 매번 걸려서 무시하게 된다. 이 도구가 하는 일은 막는 것이 아니라
 *    **무엇이 섞여 나가는지 알고 나가게 하는 것**이다.
 */

'use strict'

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA = path.join(ROOT, 'pm', 'kanban.json')
const FETCH = process.argv.includes('--fetch')

/* 커밋 제목의 작업 코드. sync-commits.js 와 **같은 정규식이어야 한다.**
   한쪽만 고치면 붙는 커밋과 점검에 잡히는 커밋이 갈린다. (docs/기능정의서.md) */
const CODE_RE = /\[(PL|FE|BE|QA|RL)-(\d+)\.(\d+)(?:\.(\d+))?\]/g
const STEP_KEYS = ['plan', 'fe', 'be', 'qa', 'release']

const COLNAME = { plan: '기획', dev: '개발', qa: 'QA', wait: '릴리즈 대기', done: '배포 완료' }

/* 문서만 바꾼 커밋. sync-commits.js 의 DOC_DIRS · DOC_FILES 와 **같은 목록이어야 한다.**
   pm/ 은 보드 도구라 서비스 배포에 안 실린다. docs/ 도 글이다.
   ⚠️ 프로젝트마다 문서 폴더가 다르다. 쓰기 전에 이 목록을 자기 레포에 맞춘다.
   이런 커밋이 섞여 나가는 것은 위험이 아니다. 화면이 안 바뀐다.
   ⚠️ 이것을 안 가르면 ③ 이 매번 커밋 전부로 뜬다. 늘 걸리는 경고는 안 보게 된다. */
const DOC_DIRS = ['pm/', 'docs/']
const DOC_FILES = ['CLAUDE.md', 'README.md']
function isDocOnly(files) {
  return files.length > 0 && files.every(f =>
    DOC_DIRS.some(d => f.startsWith(d)) || DOC_FILES.includes(f))
}

function git(args) {
  /* ⚠️ stdio 를 지정하지 않으면 stderr 가 부모에게 그대로 흘러간다.
     try/catch 로 잡은 오류까지 화면에 뜨므로(origin/main 이 없는 새 레포 등) 받아서 버린다. */
  return execSync('git ' + args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/* 브랜치 이름은 프로젝트마다 다르다. kanban.json 의 branches 에서 읽고, 없으면 아래가 기본값이다.
     "branches": { "main": "main", "work": "feature" }
   main 은 배포되는 가지, work 는 개발 세션이 커밋하는 가지다. 둘이 같아도 된다. */
let MAIN = 'main'
let WORK = 'feature'
function readBranches(b) {
  const x = b.branches || {}
  if (x.main) MAIN = String(x.main)
  if (x.work) WORK = String(x.work)
}
function gitq(args) {
  try { return git(args) } catch (e) { return '' }
}

/* 그 칸이 끝났나. sync-commits.js · kanban.html 과 같은 규칙이다. */
function isDone(s) {
  if (!s || s.status !== 'done') return false
  for (const r of s.rounds || []) if (r.status !== 'done') return false
  return true
}

/* 코드로 일감을 찾는다. 회차 코드도 그 일감을 가리킨다. */
function indexJobs(b) {
  const byCode = new Map()
  for (const j of b.jobs || []) {
    for (const k of STEP_KEYS) {
      const s = j.steps && j.steps[k]
      if (!s || !s.code) continue
      byCode.set(s.code, j)
      for (const r of s.rounds || []) if (r && r.code) byCode.set(r.code, j)
    }
  }
  return byCode
}

function codesIn(subject) {
  const out = []
  CODE_RE.lastIndex = 0
  let m
  while ((m = CODE_RE.exec(subject))) out.push(m[0].slice(1, -1))
  return out
}

/* 다음 태그를 제안한다. 정하는 것은 사람이다. (docs/기능정의서.md)
     주    기존 방식이 안 통할 만큼 크게 바뀔 때
     부    기능이 새로 추가될 때
     패치  고치기만 할 때 */
function suggestTags(last, subjects) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(last || '')
  if (!m) return null
  const [, a, b, c] = m.map(Number)
  const feat = subjects.some(s => /^feat[(:]/.test(s))
  return {
    patch: `v${a}.${b}.${c + 1}`,
    minor: `v${a}.${b + 1}.0`,
    guess: feat ? 'minor' : 'patch',
  }
}

function main() {
  if (!fs.existsSync(DATA)) {
    console.error('kanban.json 을 찾지 못했습니다: ' + DATA)
    process.exit(1)
  }

  if (FETCH) {
    console.log('원격을 받아 오는 중...')
    gitq('fetch origin --tags')
    console.log('')
  }

  const b = JSON.parse(fs.readFileSync(DATA, 'utf8'))
  readBranches(b)
  const byCode = indexJobs(b)

  /* ⚠️ 가지가 원격에 없는데 조용히 0건으로 나오면 "나갈 것이 없다" 로 읽힌다.
     설정이 틀린 것과 정말 없는 것은 다르다. 먼저 있는지 본다. */
  const missing = ['origin/' + MAIN, 'origin/' + WORK]
    .filter(r => !gitq('rev-parse --verify --quiet ' + r).trim())

  /* ── 나갈 커밋 ── */
  const raw = gitq('log --pretty=%h\x1f%s origin/' + MAIN + '..origin/' + WORK).trim()
  const commits = raw ? raw.split('\n').map(l => {
    const i = l.indexOf('\x1f')
    return { hash: l.slice(0, i), subject: l.slice(i + 1) }
  }) : []

  /* ── 그중 아직 검증 안 끝난 일감의 커밋 ──
     ⚠️ 커밋 단위로 묶는다. 한 커밋에 코드가 여럿이면 줄이 여러 개 나와 읽기 어렵다.
     ⚠️ 문서만 바꾼 커밋은 따로 센다. 섞여 나가도 화면이 안 바뀐다. */
  const risky = []
  const riskyDoc = []
  const unlinked = []
  /* 일부러 안 붙이기로 한 커밋. sync-commits.js 와 같은 목록을 본다.
     kanban.json 의 ignoredCommits 가 정본이고 이유도 거기 적는다. (2026-09-02) */
  const IGNORE = new Set((b.ignoredCommits || []).map((x) => x.hash))
  for (const c of commits) {
    if (IGNORE.has(c.hash)) continue
    const cs = codesIn(c.subject)
    if (!cs.length) { unlinked.push(c); continue }

    const hits = []
    let missing = null
    for (const code of cs) {
      const j = byCode.get(code)
      if (!j) { missing = code; continue }
      /* 릴리즈 대기 · 배포 완료가 아니면 아직 나가면 안 되는 일감이다 */
      if (j.col !== 'wait' && j.col !== 'done') hits.push({ code, job: j })
    }
    if (missing) unlinked.push({ ...c, note: '칸반에 없는 코드 ' + missing })
    if (!hits.length) continue

    const files = gitq('show --name-only --pretty=format: ' + c.hash)
      .split('\n').map(s => s.trim()).filter(Boolean)
    const row = {
      hash: c.hash,
      codes: hits.map(h => h.code).join(' '),
      jobs: hits.map(h => `${h.job.no} ${COLNAME[h.job.col] || h.job.col} 칸`).join(' · '),
      title: hits[0].job.title || '',
    }
    if (isDocOnly(files)) riskyDoc.push(row)
    else risky.push(row)
  }

  /* ── 릴리즈 대기 ── */
  const waiting = (b.jobs || []).filter(j => j.col === 'wait')

  /* ── 저장된 칸 자리가 지금 상태와 맞나 ──
     sync-commits.js 를 안 돌린 채로 배포하면 여기가 어긋난다. */
  const stale = []
  for (const j of b.jobs || []) {
    const s = j.steps || {}
    let want
    if (s.plan && !isDone(s.plan)) want = 'plan'
    else if ((s.fe && !isDone(s.fe)) || (s.be && !isDone(s.be))) want = 'dev'
    else if (!s.qa || !isDone(s.qa)) want = 'qa'
    else if (!s.release || !isDone(s.release)) want = 'wait'
    else want = 'done'
    if (j.col !== want) stale.push(`${j.no}  적힌 칸 ${COLNAME[j.col] || j.col} · 실제 ${COLNAME[want] || want}`)
  }

  /* ── 칸반에 없는 상태값이 들어 있나 (2026-09-01) ──

     이 보드가 쓰는 값은 다섯뿐이다.
       idle 대기 · doing 진행 중 · done 완료 · block 보류   (+ QA 칸만 fixed 수정 완료)

     ⚠️ 2026-09-01 실사고 — 일감을 등록하며 status 를 "todo" 로 적은 것이
        1.20 · 1.21 두 일감에 여덟 칸 들어갔다. kanban.html 은 모르는 값이 오면
        드롭다운에 그 값을 그대로 덧붙여 보여주므로(고른 것이 사라지지 않게 하는
        장치다) 화면에 "todo" 라는 영문이 그대로 떴다.

     칸 자리가 틀어지지는 않는다. isDone 이 done 만 완료로 보므로 낯선 값은
     idle 과 같게 취급된다. 그래서 **조용히 지나간다.** 여기서 잡는 이유다. */
  const OK_STATUS = ['idle', 'doing', 'done', 'block']
  const odd = []
  for (const j of b.jobs || []) {
    for (const k of STEP_KEYS) {
      const s = (j.steps || {})[k]
      if (!s) continue
      const ok = k === 'qa' ? OK_STATUS.concat(['fixed']) : OK_STATUS
      for (const e of [s].concat(s.rounds || [])) {
        if (ok.includes(e.status)) continue
        odd.push(j.no + '  ' + (e.code || k) + '  "' + e.status + '"'
                 + (e.status === 'fixed' ? '   (수정 완료는 QA 칸에만 씁니다)' : ''))
      }
    }
  }

  /* ── 미커밋 파일 ── */
  const dirty = gitq('status --porcelain').trim().split('\n').filter(Boolean)

  /* ── 원격과 어긋났나 ── */
  const ahead = (gitq('rev-list --count origin/' + WORK + '..HEAD').trim() || '0')
  const behind = (gitq('rev-list --count HEAD..origin/' + WORK).trim() || '0')

  /* ── 태그 ── */
  const lastTag = (gitq('describe --tags --abbrev=0 origin/' + MAIN).trim()
                  || gitq('tag -l --sort=-creatordate').trim().split('\n')[0] || '')
  const tags = suggestTags(lastTag, commits.map(c => c.subject))

  /* ══ 출력 ══ */
  const now = new Date()
  const p2 = n => (n < 10 ? '0' : '') + n
  console.log('배포 전 점검   ' + now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate())
              + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes())
              + (FETCH ? '' : '   (원격을 안 받아 왔습니다. --fetch 를 붙이면 받아 옵니다)'))
  console.log('')

  console.log('① 나갈 커밋  ' + commits.length + '건   origin/' + MAIN + '..origin/' + WORK)
  if (missing.length) {
    console.log('   ⚠️ 원격에 없는 가지: ' + missing.join(' · '))
    console.log('   → kanban.json 의 branches 를 자기 저장소에 맞춰 주세요. 아래 숫자를 믿을 수 없습니다.')
  } else if (!commits.length) {
    console.log('   나갈 것이 없습니다. ' + MAIN + ' 과 ' + WORK + ' 가 같습니다.')
  }
  console.log('')

  console.log('② 릴리즈 대기  ' + waiting.length + '건')
  if (!waiting.length) console.log('   없습니다. 지금 내보낼 일감이 없습니다.')
  for (const j of waiting) console.log('   ' + j.no.padEnd(8) + (j.title || ''))
  console.log('')

  console.log('③ 섞여 나갈 코드 커밋  ' + risky.length + '건')
  if (!risky.length) {
    console.log('   없습니다. 검증 안 끝난 일감 중 코드가 바뀐 커밋이 없습니다.')
  } else {
    console.log('   아직 검증이 안 끝난 일감의 커밋인데 코드가 바뀝니다.')
    console.log('   머지하면 이것도 같이 나갑니다. 골라낼 수 없습니다.')
    for (const r of risky) console.log('   ' + r.hash + '  [' + r.codes + ']  ' + r.jobs + '  ' + r.title)
  }
  if (riskyDoc.length) {
    console.log('   (참고) 문서만 바뀐 것 ' + riskyDoc.length + '건은 화면이 안 바뀌어 뺐습니다.')
    for (const r of riskyDoc) console.log('     ' + r.hash + '  [' + r.codes + ']  ' + r.jobs)
  }
  console.log('')

  console.log('④ 정리 안 된 커밋  ' + unlinked.length + '건')
  if (!unlinked.length) console.log('   없습니다.')
  for (const c of unlinked) console.log('   ' + c.hash + '  ' + c.subject + (c.note ? '   (' + c.note + ')' : ''))
  if (IGNORE.size) console.log('   (일부러 뺀 커밋 ' + IGNORE.size + '건 — kanban.json 의 ignoredCommits)')
  console.log('')

  console.log('⑤ 미커밋 파일  ' + dirty.length + '건')
  if (!dirty.length) console.log('   없습니다.')
  for (const l of dirty) console.log('   ' + l)
  if (dirty.length) console.log('   → 다른 세션이 작업 중일 수 있습니다. 배포 전에 확인해 주세요.')
  console.log('')

  console.log('⑥ 칸 자리  ' + (stale.length ? stale.length + '건 어긋남' : '맞습니다'))
  for (const l of stale) console.log('   ' + l)
  if (stale.length) console.log('   → node pm/sync-commits.js --write 를 먼저 돌려 주세요.')
  console.log('')

  console.log('⑦ 상태값  ' + (odd.length
    ? '⚠️ 칸반에 없는 값 ' + odd.length + '개'
    : '쓰는 값만 들어 있습니다'))
  for (const l of odd) console.log('   ' + l)
  if (odd.length) {
    console.log('   → 쓰는 값은 idle 대기 · doing 진행 중 · done 완료 · block 보류 넷입니다.')
    console.log('     QA 칸만 fixed 수정 완료를 하나 더 씁니다.')
    console.log('   → 칸 자리는 안 틀어집니다. 다만 화면 드롭다운에 그 값이 영문으로 그대로 뜹니다.')
  }
  console.log('')

  console.log('⑧ 로컬과 원격  ' + (ahead === '0' && behind === '0'
    ? 'feature 가 같습니다'
    : '⚠️ 안 올린 커밋 ' + ahead + '건 · 안 받은 커밋 ' + behind + '건'))
  if (ahead !== '0') console.log('   → git push origin ' + WORK + ' 를 먼저 해 주세요.')
  console.log('')

  console.log('⑨ 마지막 태그  ' + (lastTag || '(없음)'))
  if (tags) {
    console.log('   다음 태그   ' + tags.patch + '  고치기만 했을 때'
                + (tags.guess === 'patch' ? '   ← 나갈 커밋에 feat 가 없습니다' : ''))
    console.log('              ' + tags.minor + '  기능이 새로 들어갔을 때'
                + (tags.guess === 'minor' ? '   ← 나갈 커밋에 feat 가 있습니다' : ''))
    console.log('   정하는 것은 사람입니다. 위는 제안입니다.')
  }
  console.log('')

  /* ── 요약 ── */
  console.log('─'.repeat(60))
  const warn = []
  if (risky.length) warn.push('검증 안 끝난 코드 커밋 ' + risky.length + '건이 섞여 나갑니다')
  if (unlinked.length) warn.push('정리 안 된 커밋 ' + unlinked.length + '건')
  if (dirty.length) warn.push('미커밋 파일 ' + dirty.length + '건')
  if (stale.length) warn.push('칸 자리 ' + stale.length + '건 어긋남')
  if (odd.length) warn.push('칸반에 없는 상태값 ' + odd.length + '개')
  if (ahead !== '0') warn.push('안 올린 커밋 ' + ahead + '건')

  if (!commits.length) {
    console.log('나갈 것이 없습니다.')
  } else if (!warn.length) {
    console.log('걸리는 것이 없습니다. 릴리즈 대기 ' + waiting.length + '건이 나갑니다.')
  } else {
    console.log('⚠️ 확인하고 판단해 주세요')
    for (const w of warn) console.log('   · ' + w)
  }
  console.log('')
  console.log('머지하려면')
  console.log('   git push origin ' + WORK + ':' + MAIN)
  console.log('   git tag -a <태그> -m "<무엇이 나갔는지>"')
  console.log('   git push origin <태그>')
  console.log('   node pm/sync-commits.js --write · node pm/make-report.js --write')
  console.log('')
}

main()

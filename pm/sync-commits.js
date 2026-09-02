#!/usr/bin/env node
/**
 * pm/sync-commits.js — git 커밋을 칸반에 이어 붙인다.
 *
 *   node pm/sync-commits.js            무엇이 바뀔지 보기만 한다
 *   node pm/sync-commits.js --write    pm/kanban.json 을 실제로 고친다
 *
 * ⚠️ 진행 관리의 정본은 pm/kanban.json 하나다.
 *    board.json 은 그날 상태로 얼려 둔 사본이고 아무도 안 고친다. (docs/기능정의서.md)
 *
 * 하는 일 넷
 *
 *   ① 이어 붙이기
 *      커밋 제목에 [FE-1.6] 처럼 작업 코드가 있으면 그 칸의 commits 에 해시를 넣는다.
 *      한 커밋에 코드가 여러 개 있어도 되고, 한 칸에 커밋이 여러 개 붙어도 된다.
 *
 *   ② 배포 완료로 넘기기
 *      나머지 칸이 다 끝났고 커밋이 전부 origin/main 에 있으면 릴리즈 칸을 완료로 찍는다.
 *      배포 태그와 push 시각도 함께 적는다.
 *
 *   ③ 칸 자리 다시 계산
 *      상태가 바뀌면 그 일감이 서는 칸도 바뀐다. 사람이 끌어 옮기지 않는다.
 *
 *   ④ 빠진 것 찾기
 *      코드가 없어 어느 칸에도 안 붙은 커밋을 unlinked 에 모은다.
 *      그것을 보고 사람이 일감으로 정리하면 기록이 빠지지 않는다.
 *
 * 몇 번을 돌려도 결과가 같다. 며칠 빠뜨렸다가 한 번 돌려도 그대로 복구된다.
 */

'use strict'

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import { fileURLToPath } from 'url'
/* ⚠️ stamp 는 이 파일에 이미 있다(배포 태그를 찍는 것). 별칭으로 받는다. */
import { acquire, release, stamp as lockStamp, busyMessage } from './lock.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA = path.join(ROOT, 'pm', 'kanban.json')
const WRITE = process.argv.includes('--write')

/* 잠금 파일에 누가 잡았는지 적는다. 사람이 읽으려는 것이고 판정에는 안 쓴다.
   PO 가 돌릴 때는 --as PO 를 붙이면 된다. 안 붙여도 잠금은 똑같이 걸린다. */
const AS = (function () {
  const i = process.argv.indexOf('--as')
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'PM'
})()

/* 작업 코드: [PL-1.2] · [FE-90.3] · [BE-1.1] · [QA-92.1] · [RL-9.1]
   QA 와 RL 은 셋째 자리가 붙는다 — 회차다. QA-1.2.1 이 2회차다. (docs/기능정의서.md)

   ⚠️ **대괄호 안에 든 것만 읽는다.** 제목 안에 코드를 설명으로 적는 일이 있는데
      (2026-08-31 `2dacc50` — "FE-1.6 칸 삭제"), 그것까지 코드로 읽으면
      "칸반에 없는 코드" 경고가 매번 뜬다. 무시해도 되는 경고가 늘 떠 있으면
      진짜일 때도 안 보게 된다.
      대괄호를 빠뜨린 커밋은 "정리 안 된 커밋" 으로 보이므로 조용히 사라지지 않는다.
      실측 — 이 레포 커밋 143건 중 대괄호 없이 코드를 적은 것은 위 하나뿐이다. */
const CODE_RE = /\[(PL|FE|BE|QA|RL)-(\d+)\.(\d+)(?:\.(\d+))?\]/g
const STEP_KEYS = ['plan', 'fe', 'be', 'qa', 'release']

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

/* kanban.json 안의 모든 칸을 코드로 찾을 수 있게 펼친다 */
function indexSteps(b) {
  const byCode = new Map()
  for (const j of b.jobs || []) {
    for (const k of STEP_KEYS) {
      const s = j.steps && j.steps[k]
      if (!s || !s.code) continue
      byCode.set(s.code, { step: s, job: j })
      /* QA 회차도 커밋을 따로 받는다. 회차마다 그 회차에서 고친 것이 붙는다. */
      for (const r of s.rounds || []) {
        if (r && r.code) byCode.set(r.code, { step: r, job: j })
      }
    }
  }
  return byCode
}

/* 그 칸이 끝났나. QA 칸은 회차가 하나라도 안 끝나면 끝난 것이 아니다.
   ⚠️ kanban.html 의 isDone 과 같은 규칙이다. 한쪽만 고치면 화면과 데이터가 갈린다. */
function isDone(s){
  if (!s || s.status !== 'done') return false
  for (const r of s.rounds || []) if (r.status !== 'done') return false
  return true
}

/* 그 칸에 붙은 커밋 전부. QA 는 회차에 붙은 것도 이 칸의 커밋이다. */
function commitsOf(s){
  const out = []
  if (!s) return out
  for (const h of s.commits || []) out.push(h)
  for (const r of s.rounds || []) for (const h of r.commits || []) out.push(h)
  return out
}

/* 이 일감이 어느 칸에 서는가. kanban.html 의 colOf 와 같은 규칙이다.
   ⚠️ 두 자리에 같은 규칙이 있다. 한쪽만 고치면 화면과 데이터가 갈린다. */
function colOf(j) {
  const s = j.steps
  if (s.plan && !isDone(s.plan)) return 'plan'
  /* 개발 칸이 없으면 기획으로 끝나는 일감이다. 여기서 멈추지 않는다. */
  if ((s.fe && !isDone(s.fe)) || (s.be && !isDone(s.be))) return 'dev'
  if (!s.qa || !isDone(s.qa)) return 'qa'
  if (!s.release || !isDone(s.release)) return 'wait'
  return 'done'
}

/* main 에 push 된 커밋마다 { 그 push 의 머지 커밋 · 시각 · 태그 } 를 매긴다.
   출처는 git reflog show origin/main 이고, push 시각은 거기에만 남는다.
   ⚠️ reflog 는 이 컴퓨터에만 있다. 다른 기기에서 돌리면 이 단계가 비어
      배포 완료로 안 넘어간다. 그때는 그 컴퓨터에서 한 번 돌리면 된다. */
function mainPushes() {
  const out = {}
  let rows = []
  try {
    rows = git('reflog show origin/' + MAIN + ' --date=iso').trim().split('\n').reverse()
      .map(l => ({ h: l.split(' ')[0], d: (l.match(/\{([^}]+)\}/) || [])[1] || '' }))
  } catch (e) {
    return out
  }
  let prev = null
  for (const r of rows) {
    const range = prev ? prev + '..' + r.h : r.h
    let log = ''
    try { log = git('log ' + range + ' --pretty=%h') } catch (e) {}
    let tag = ''
    try { tag = git('tag --points-at ' + r.h).trim().split('\n')[0] || '' } catch (e) {}
    for (const h of log.trim().split('\n').filter(Boolean)) {
      out[h] = { commit: r.h, at: r.d.slice(0, 16), tag: tag }
    }
    prev = r.h
  }
  return out
}

/* 배포 하나를 그 칸에 적는다. */
function stamp(e, p) {
  e.status = 'done'
  e.doneAt = p.at.slice(0, 10)
  e.shippedCommit = p.commit
  e.shippedAt = p.at
  if (p.tag) e.shippedTag = p.tag
}

/* 마지막으로 나간 배포가 적힌 칸. 회차가 있으면 마지막 회차다. */
function lastRel(rl) {
  const rs = rl.rounds || []
  return rs.length ? rs[rs.length - 1] : rl
}

function nextRoundN(s) {
  let n = 0
  for (const r of s.rounds || []) if (r.n > n) n = r.n
  return n + 1
}

/* 기록만 한 커밋. 진행 데이터 말고는 아무 파일도 안 바뀐 커밋이다.
   PO 가 작업 코드를 새로 만들 때 쓰는 "등록 커밋" 이 여기 걸린다.

   ⚠️ 커밋은 그대로 이어 붙이되 **그 칸을 완료로 찍지 않는다.**
      2026-08-31 실사고 — 등록 커밋 1705997 하나가 QA-1.6.1 을 만들자마자
      완료로 찍었다. 되돌려도 --write 를 다시 돌리면 그 커밋을 또 찾아내 재발했다.
   ⚠️ 보드 도구를 고치는 커밋은 pm/kanban.html · pm/*.js 가 함께 바뀌므로 안 걸린다. */
/* 커밋마다 바뀐 파일 목록. 한 번에 물어보고 아래 두 군데서 나눠 쓴다. */
function filesOf(hashes) {
  const map = new Map()
  const list = [...new Set(hashes)].filter(Boolean)
  if (!list.length) return map
  let raw = ''
  try {
    raw = git(`log --no-walk --ignore-missing --format=%x01%h --name-only ${list.join(' ')}`)
  } catch (e) { return map }
  const NL = String.fromCharCode(10)
  let h = null
  for (const line of raw.split(NL)) {
    /* git 에게 커밋 머리마다 0x01 을 찍게 했다. 파일 이름에 안 나오는 글자다. */
    if (line.charCodeAt(0) === 1) { h = line.slice(1).trim(); map.set(h, []); continue }
    const f = line.trim()
    if (f && h) map.get(h).push(f)
  }
  return map
}

/* ㉮ 기록만 한 커밋. 진행 데이터 말고는 아무 파일도 안 바뀐 커밋이다.
   PO 가 작업 코드를 새로 만들 때 쓰는 "등록 커밋" 이 여기 걸린다.

   ⚠️ 커밋은 그대로 이어 붙이되 **그 칸을 완료로 찍지 않는다.**
      2026-08-31 실사고 — 등록 커밋 1705997 하나가 QA-1.6.1 을 만들자마자
      완료로 찍었다. 되돌려도 --write 를 다시 돌리면 그 커밋을 또 찾아내 재발했다.
   ⚠️ 보드 도구를 고치는 커밋은 pm/kanban.html · pm/*.js 가 함께 바뀌므로 안 걸린다. */
const RECORD_FILES = ['pm/kanban.json', 'pm/진행표.md']
function isRecordOnly(files) {
  return files.length > 0 && files.every(f => RECORD_FILES.includes(f))
}

/* ㉯ 문서만 바꾼 커밋. **배포를 가릴 때** 뺀다.
   ⚠️ ㉮ 와 목록이 다르다. 규칙 문서를 고치는 것은 기획 작업의 결과물일 수 있어
      완료로는 찍는다. 다만 그것이 "배포" 는 아니다.
      2026-08-31 실측 — 이 구분이 없으면 옛 일감 9개가 재배포로 잘못 잡힌다.
      문서 커밋이 나중 push 에 실렸다는 이유만으로 2차 배포가 생겼다. */
const DOC_DIRS = ['pm/', 'docs/']
const DOC_FILES = ['CLAUDE.md', 'README.md']
function isDocOnly(files) {
  return files.length > 0 && files.every(f =>
    DOC_DIRS.some(d => f.startsWith(d)) || DOC_FILES.includes(f))
}

function devBadge(s) {
  const fe = !!s.fe, be = !!s.be
  if (fe && be) return 'FS'
  if (fe) return 'FE'
  if (be) return 'BE'
  return null
}

function main() {
  if (!fs.existsSync(DATA)) {
    console.error('kanban.json 을 찾지 못했습니다: ' + DATA)
    process.exit(1)
  }
  /* ⚠️ 읽기 전에 잠금을 잡는다. (2026-09-01 결정 사항)
     여기서 읽고 git 을 훑고 다시 쓰기까지가 임계 구간이다(실측 2초).
     그 사이에 칸반 화면이 저장하면 나중 쪽이 먼저 것을 덮어쓴다.
     --write 가 없으면 아무것도 안 고치므로 잠그지 않는다. (pm/lock.js 참고) */
  let lock = null
  if (WRITE) {
    lock = acquire(AS)
    if (!lock) {
      console.error(busyMessage())
      process.exit(1)
    }
    /* process.exit 은 finally 를 건너뛴다. 어떻게 끝나도 풀리게 여기에 건다. */
    process.on('exit', () => release(lock))
  }

  const b = JSON.parse(fs.readFileSync(DATA, 'utf8'))
  readBranches(b)
  /* 쓰기 직전에 이것과 견준다. 잠금이 만료로 뺏겼는지 보는 마지막 관문이다. */
  const openedAt = b.updatedAt
  if (!b.jobs) {
    console.error('kanban.json 이 옛 구조입니다. jobs 가 없습니다.')
    process.exit(1)
  }
  const byCode = indexSteps(b)

  /* 어디부터 볼지. 이 커밋 "다음"부터 검사한다.
     비어 있으면 전체를 본다. kanban.json 의 syncSince 가 정본이다. */
  const since = b.syncSince || ''
  const range = since ? `${since}..HEAD` : 'HEAD'

  let raw = ''
  try {
    raw = git(`log ${range} --no-merges --date=short --format=%h%x09%ad%x09%s`)
  } catch (e) {
    console.error('git log 를 읽지 못했습니다. syncSince 값이 이 레포에 없는 커밋일 수 있습니다.')
    console.error('  syncSince =', since || '(없음)')
    process.exit(1)
  }

  const commits = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...rest] = line.split('\t')
      return { hash, date, subject: rest.join('\t') }
    })

  /* 손으로 이미 넣어 둔 해시는 정리된 것으로 본다 */
  const already = new Set()
  for (const { step } of byCode.values()) for (const h of step.commits || []) already.add(h)

  /* ⚠️ 범위 안 커밋만 보면 안 된다. 릴리즈 판정은 **보드에 이미 적힌 옛 해시**도 본다.
     그 안에 기록 커밋이 섞여 있으면 재배포로 오인한다. 2026-08-31 실측 9건. */
  const onBoard = []
  for (const { step } of byCode.values()) for (const h of step.commits || []) onBoard.push(h)
  const CHANGED = filesOf(commits.map(c => c.hash).concat(onBoard))
  const recOnly = new Set()
  const docOnly = new Set()
  for (const [h, files] of CHANGED) {
    if (isRecordOnly(files)) recOnly.add(h)
    if (isDocOnly(files)) docOnly.add(h)
  }
  const linked = []
  const recorded = []
  const unlinked = []
  /* 코드 → 그 코드를 처음 적은 커밋. 어느 커밋 때문인지 보여야 손을 쓸 수 있다. */
  const missingCode = new Map()
  const badRound = new Set()
  const touched = new Set()
  /* 일부러 안 붙이기로 한 커밋. kanban.json 의 ignoredCommits 에 이유와 함께 적는다.
     (2026-09-02 결정 사항 — 47aa645 가 갈 곳 없이 계속 떠 있었다)
     ⚠️ 남용하면 "빠뜨림을 눈에 보이게 하는 장치" 가 죽는다. **갈 곳이 정말 없는 것만** 넣는다.
        예 — 일감이 다른 일감으로 병합돼 그 코드가 사라진 경우.
        아직 안 붙였을 뿐인 커밋은 넣지 않는다. 그건 일감을 만들어 붙일 일이다.
     ⚠️ 숨기되 없애지는 않는다. 몇 건을 뺐는지 끝에 한 줄로 보여 준다. */
  const IGNORE = new Set((b.ignoredCommits || []).map((x) => x.hash))

  for (const c of commits) {
    const codes = []
    let m
    CODE_RE.lastIndex = 0
    while ((m = CODE_RE.exec(c.subject)) !== null) {
      /* m[0] 은 대괄호까지 물고 있다. 코드만 다시 짜 맞춘다. */
      const code = m[1] + '-' + m[2] + '.' + m[3] + (m[4] !== undefined ? '.' + m[4] : '')
      /* 셋째 자리는 회차이고 QA · RL 에만 쓴다. 다른 칸에 붙어 오면 잘못 적은 것이다. */
      if (m[4] !== undefined && m[1] !== 'QA' && m[1] !== 'RL') { badRound.add(code); continue }
      codes.push(code)
    }

    if (!codes.length) {
      if (!already.has(c.hash) && !IGNORE.has(c.hash)) unlinked.push(c)
      continue
    }
    for (const code of codes) {
      const hit = byCode.get(code)
      if (!hit) {
        /* 코드를 잘못 적었더라도 그 커밋이 이미 어느 칸엔가 붙어 있으면
           정리는 끝난 것이다. 커밋 제목은 나중에 고칠 수 없으므로 넘어간다. */
        if (!already.has(c.hash) && !IGNORE.has(c.hash) && !missingCode.has(code)) missingCode.set(code, c)
        continue
      }
      const t = hit.step
      if (!t.commits) t.commits = []
      if (!t.commits.includes(c.hash)) {
        t.commits.push(c.hash)
        linked.push(`${code}  ${c.hash}  ${c.subject}`)
        touched.add(hit.job)
      }
      /* 커밋이 붙으면 그 칸은 끝난 것으로 본다.
         이 레포는 작업 단위로 커밋하고 커밋 제목에 작업 코드를 단다.
         그래서 코드가 붙은 커밋이 곧 완료 기록이다.

         완료일은 **마지막 커밋 날짜**다. 관련 커밋이 한 번 더 나면 그날로 갱신된다
         (2026-08-28 확정 사항 · docs/기능정의서.md).
         ⚠️ 보류(block)로 세워 둔 것은 건드리지 않는다. 사람이 일부러 세운 것이다. */
      /* ⚠️ 기록만 한 커밋은 완료로 안 찍는다. 위 recordOnly 를 보라. */
      if (recOnly.has(c.hash)) {
        recorded.push(`${code}  ${c.hash}  ${c.subject}`)
        continue
      }
      /* ⚠️ QA 칸만은 커밋이 붙어도 **완료로 안 찍는다.** 커밋은 "고쳤다" 는 기록이지
         "검증했다" 는 기록이 아니다. 검증은 검증 담당자가 화면을 보고 한다.
         그래서 QA 는 수정 완료(fixed)까지만 올리고, 검증 완료는 사람이 찍는다.
         (2026-08-31 확정 사항 · docs/기능정의서.md)

         ⚠️ 이미 검증 완료(done)인 것은 내리지 않는다. 붙은 커밋은 다시 안 붙지만
            이 줄은 돌 때마다 지나가므로, 내리면 매번 검증이 풀린다. */
      const goal = code.startsWith('QA-') ? 'fixed' : 'done'
      if (t.status !== 'block' && !(goal === 'fixed' && t.status === 'done')) {
        t.status = goal
        if (!t.doneAt || t.doneAt < c.date) t.doneAt = c.date
        touched.add(hit.job)
      }
    }
  }

  /* ② main 에 나간 일감의 릴리즈 칸을 완료로 찍는다.
     "PO 가 main 에 머지하면 배포 완료로 올라온다" 는 규칙을 여기서 실행한다. (docs/기능정의서.md)

     ⚠️ 그 일감에 안 끝난 칸이 하나라도 남아 있으면 찍지 않는다.
        2026-08-28 백필 때 이 조건이 없어 FE-0.2 · BE-1.5 · FE-1.6 · QA-1.3 처럼
        아직 대기인 일이 완료로 찍힐 뻔했다. */
  const shipped = []
  const reship = []
  const fixedRel = []
  const paired = []
  const lateTag = []
  const dropped = []
  const pushOf = mainPushes()

  /* ⓪-1 뒤늦게 붙인 배포 태그를 채운다. (2026-09-01)

     배포 태그는 그 배포를 **처음 적을 때만** 읽는다(stamp). 그래서 main 에 머지한 뒤
     태그를 나중에 따로 붙이면, 몇 번을 다시 돌려도 그 태그가 칸반에 안 들어온다.
     아래 ㉢ 이 "이미 적힌 배포와 같은 push 면 넘어간다" 로 먼저 걸러 내기 때문이다.

     ⚠️ 2026-08-31 실사고 — 8edced5 가 태그 없이 나갔다. 1.15 · 1.17 · 1.19 세 카드의
        배지가 태그 대신 날짜(8/31)로 떨어졌고, 뒤늦게 태그를 붙여도 안 돌아왔다.
        카드 배지는 **마지막 회차**의 태그를 보이므로(kanban.html lastRel), 마지막
        배포에 태그가 없으면 앞 회차에 태그가 있어도 소용이 없다.

     채우는 것은 태그뿐이다. 상태 · 완료일 · 커밋 · 배포 시각은 건드리지 않는다.
     git 에 태그가 없으면 아무것도 안 한다. */
  const tagMemo = {}
  for (const j of b.jobs) {
    const r0 = j.steps && j.steps.release
    if (!r0) continue
    for (const e of [r0].concat(r0.rounds || [])) {
      if (!e.shippedCommit || e.shippedTag) continue
      const h = String(e.shippedCommit)
      if (!(h in tagMemo)) {
        let t = ''
        try { t = git('tag --points-at ' + h).trim().split('\n')[0] || '' } catch (err) {}
        tagMemo[h] = t
      }
      if (!tagMemo[h]) continue
      e.shippedTag = tagMemo[h]
      lateTag.push(`${e.code || ('RL-' + j.no)}  ${tagMemo[h]}  ${h}  ${j.title || ''}`)
    }
  }

  for (const j of b.jobs) {
    const rl = j.steps.release
    if (!rl || rl.status === 'block') continue

    /* ⓪ QA 회차마다 릴리즈 회차를 하나씩 둔다. 대기 상태로 만든다.
       QA 가 되돌아왔다는 것은 고친 것을 **다시 배포해야 한다**는 뜻이다.

       ⚠️ 짝이 없으면 QA 회차를 완료로 바꾸는 순간, 옛 릴리즈가 완료라서
          그 일감이 곧바로 배포 완료로 간다. 고친 것은 아직 feature 에만 있는데도 그렇다.
          2026-08-31 실사고 — QA-1.6.1 을 완료로 바꾸자 1.6 이 배포 완료로 갔다.
       ⚠️ 한 번도 안 나간 일감에는 안 만든다. 그때는 기본 RL 이 곧 그 배포다. */
    const qaStep = j.steps.qa
    if (rl.status === 'done' && qaStep && (qaStep.rounds || []).length) {
      for (const q of qaStep.rounds) {
        if ((rl.rounds || []).some(r => r.n === q.n)) continue
        /* ⚠️ 그 회차에서 고친 것이 **이미 다 나갔으면** 짝을 만들지 않는다. (2026-09-01)
           재배포할 것이 없어 그 자리가 영영 안 채워지고, 그 일감이 릴리즈 대기 칸에
           선 채로 멈춘다.
           2026-08-31 실측 — QA-1.15.2 의 커밋 셋(e8de4d2 · 9d65008 · a7c5a24)이
           17:58 v1.5.0 에 실려 나간 **뒤에** 회차가 만들어져, 짝 RL-1.15.2 가
           빈 채로 남았다. 그 탓에 1.15 가 배포 완료로 못 넘어갔다.
           ⚠️ 이 관문이 없으면 사람이 화면에서 그 빈 회차를 지워도 다음 실행에서
              다시 생긴다. 지우는 버튼만으로는 못 고친다.
           커밋이 아직 하나도 없으면 고치는 중이므로 그대로 만든다. */
        /* ⚠️ 문서만 바꾼 커밋은 세지 않는다. (2026-09-01 PO 제보로 보강)
           QA 칸에는 "검증 완료 반영" 같은 pm/kanban.json 커밋이 함께 붙는다.
           그것까지 세면 아직 안 나간 커밋이 있는 것으로 보여 이 관문을 못 넘고,
           **이미 코드가 다 나간 회차에 짝이 또 생긴다.**
           2026-09-01 실사고 — QA-1.18.1 의 코드(336e90e)는 v1.6.0 에 나갔는데
           같은 칸에 붙은 문서 커밋 때문에 RL-1.18.1 이 만들어졌고, 그 빈 회차가
           isDone 을 막아 1.18 이 배포 완료에서 릴리즈 대기로 되돌아갔다. */
        const qc = (q.commits || []).map(h => String(h).slice(0, 7))
          .filter(h => !docOnly.has(h))
        if (qc.length && qc.every(h => pushOf[h])) continue
        if (!rl.rounds) rl.rounds = []
        rl.rounds.push({ code: rl.code + '.' + q.n, n: q.n, title: '', desc: '', ref: '',
                         status: 'idle', doneAt: null, commits: [], includes: [] })
        paired.push(`${rl.code}.${q.n}  ${j.title || ''}`)
      }
      if (rl.rounds) rl.rounds.sort((x, y) => x.n - y.n)
    }

    /* 릴리즈 말고 나머지 칸이 다 끝났는가 */
    const rest = STEP_KEYS.filter(k => k !== 'release')
    if (!rest.every(k => !j.steps[k] || isDone(j.steps[k]))) continue

    /* 그 일감의 커밋이 전부 origin/main 에 있는가.
       ⚠️ 문서만 바꾼 커밋은 뺀다. 안 빼면 그 커밋이 실린 나중 push 가 재배포로 잡힌다.
          다만 문서가 곧 결과물인 일감(규칙 개정 등)은 뺄 것이 없으므로 그대로 쓴다. */
    const all = []
    const real = []
    for (const k of STEP_KEYS) {
      for (const h of commitsOf(j.steps[k])) {
        const sh = String(h).slice(0, 7)
        all.push(sh)
        if (!docOnly.has(sh)) real.push(sh)
      }
    }
    const cs = real.length ? real : all
    if (!cs.length) continue
    if (!cs.every(h => pushOf[h])) continue

    /* 가장 늦게 나간 push 가 이 일감의 마지막 배포다 */
    let best = null
    for (const h of cs) {
      const p = pushOf[h]
      if (!best || p.at > best.at) best = p
    }

    /* ㉠ 아직 안 나간 첫 배포. 릴리즈 칸에 그대로 적는다. */
    if (rl.status !== 'done') {
      stamp(rl, best)
      shipped.push(`${rl.code}  ${best.tag || best.commit}  ${best.at}  ${j.title || ''}`)
      continue
    }

    /* ㉡ 옛 기록 보정. 배포가 끝났다고 적혀 있는데 어느 push 였는지가 비어 있다.
       2026-08-28 백필로 만든 칸들이 그렇다.

       ⚠️ **회차가 이미 붙어 있어도 채운다.** 안 채우면 아래 ㉢ 이 옛 배포를
          새 배포로 착각해 대기 중인 회차를 그 자리에서 완료로 찍는다.
          2026-08-31 PO 세션 제보 — QA-1.3 을 완료로 바꾸자 main 에 아무것도
          새로 안 나갔는데 1.3 이 곧바로 배포 완료로 뛰었다.
       ⚠️ 여기서 회차를 만들지는 않는다.
       ⚠️ **best 를 쓰면 안 된다.** best 는 그 뒤에 붙은 커밋까지 본 값이라
          옛 배포가 최신 배포로 둔갑한다. 그때 나간 것은
          **완료일까지의 push 중 가장 늦은 것**이다. */
    if (rl.status === 'done' && !rl.shippedCommit) {
      let old = null
      for (const h of cs) {
        const p = pushOf[h]
        if (rl.doneAt && p.at.slice(0, 10) > rl.doneAt) continue
        if (!old || p.at > old.at) old = p
      }
      /* 완료일이 비어 있으면 그때를 가릴 수 없다. **가장 이른 push** 로 둔다.
         ⚠️ best(마지막 push)로 두면 안 된다. 나중에 붙은 커밋이 이미 나간 것으로
            둔갑해, 그 커밋의 진짜 배포가 영영 안 잡힌다.
            0.1 · 7.2 · 3.1 처럼 커밋 없이 닫은 일감이 이 자리에 온다. */
      if (!old) for (const h of cs) {
        const p = pushOf[h]
        if (!old || p.at < old.at) old = p
      }
      /* ⚠️ 상태와 완료일은 안 건드린다. 사람이 정해 둔 값이고, 바꾸면
         액션 플랜의 "어제 한 일" 이 흔들린다. 여기서 채우는 것은 배포 정보뿐이다. */
      rl.shippedCommit = old.commit
      rl.shippedAt = old.at
      if (old.tag) rl.shippedTag = old.tag
      fixedRel.push(`${rl.code}  ${old.tag || old.commit}  ${old.at}  ${j.title || ''}`)
    }

    /* ㉮ 채울 배포가 없는 빈 릴리즈 회차를 지운다. (2026-09-01 결정 사항)

       여기까지 왔다는 것은 **그 일감의 커밋이 전부 main 에 나갔다**는 뜻이다
       (위의 cs.every(pushOf) 를 통과했다). 그런데 아래 두 관문에서 걸리면
       **새로 나간 것이 없다.** 그렇다면 열려 있는 빈 회차는 채워질 일이 없다.
       그대로 두면 그 일감이 릴리즈 대기 칸에 영영 선다.

       ⚠️ 아직 안 나간 커밋이 있는 일감은 여기 오지 못한다. 그 회차는
          **정말로 배포를 기다리는 자리**라 지우면 안 된다.
          2026-09-01 실측 — 1.18 이 그랬다. 1.3 · 1.15 와 갈라야 한다.
       ⚠️ 기록이 든 회차는 안 지운다. 커밋 · 제목 · 상세가 하나라도 있으면 남긴다.
          나간 회차(done · shippedCommit)도 그대로 둔다. 배포 기록은 사실이다.

       처음엔 화면에 × 를 붙여 사람이 지우게 만들었다가 되돌렸다. 판정 근거가
       전부 여기 있는데 사람 손을 빌릴 이유가 없다. */
    function dropEmpty(why) {
      if (!rl.rounds || !rl.rounds.length) return
      rl.rounds = rl.rounds.filter(r => {
        const keep = r.status === 'done' || r.shippedCommit
          || (r.commits || []).length || r.desc || r.title
        if (!keep) dropped.push(`${r.code}  ${j.title || ''}   ${why}`)
        return keep
      })
    }

    /* 이미 적힌 배포와 같은 push 면 새로 나간 것이 없다. */
    const done = [rl].concat(rl.rounds || []).filter(e => e.status === 'done')
    if (done.some(e => e.shippedCommit === best.commit)) {
      dropEmpty('이미 ' + (best.tag || best.commit) + ' 로 나갔습니다')
      continue
    }

    /* ⚠️ 마지막으로 적힌 배포보다 **늦은** push 여야 새 배포다.
       이 관문이 ㉢ 앞에 있어야 한다. 뒤에 두면 대기 회차가 옛 배포로 채워진다. */
    let seen = ''
    for (const e of done) {
      const at = e.shippedAt || e.doneAt || ''
      if (at > seen) seen = at
    }
    if (!(best.at > seen)) {
      dropEmpty('마지막 배포 뒤로 새로 나간 것이 없습니다')
      continue
    }

    /* ㉢ 열려 있는 릴리즈 회차가 있으면 **거기에 적는다.**
       ⓪ 에서 QA 회차와 짝지어 미리 만들어 둔 자리다. 새로 만들지 않는다. */
    const open = (rl.rounds || []).filter(r => r.status !== 'done')[0]
    if (open) {
      stamp(open, best)
      reship.push(`${open.code}  ${best.tag || best.commit}  ${best.at}  ${j.title || ''}`)
      continue
    }

    /* ㉣ 짝이 없는데 새 push 가 있다. QA 회차 없이 다시 나간 경우다.
       ⚠️ 릴리즈 회차는 사람이 안 만든다. 여기서 자동으로 생긴다. (docs/기능정의서.md)
       같은 push 를 두 번 적지 않으므로 몇 번을 돌려도 결과가 같다. */
    const n = nextRoundN(rl)
    const round = { code: rl.code + '.' + n, n: n, title: '', desc: '', ref: '',
                    status: 'done', doneAt: null, commits: [], includes: [] }
    stamp(round, best)
    if (!rl.rounds) rl.rounds = []
    rl.rounds.push(round)
    reship.push(`${round.code}  ${best.tag || best.commit}  ${best.at}  ${j.title || ''}`)
  }

  /* ③ 칸 자리를 다시 계산한다. 상태가 바뀌면 서는 칸도 바뀐다. */
  const moved = []
  for (const j of b.jobs) {
    const before = j.col
    j.col = colOf(j)
    j.dev = devBadge(j.steps)
    if (before !== j.col) moved.push(`${j.no}  ${j.title || ''}   ${before} → ${j.col}`)
  }

  b.unlinked = unlinked.map((c) => ({ hash: c.hash, date: c.date, subject: c.subject }))

  /* ── 결과 ── */
  console.log(`검사 범위: ${since ? since + ' 다음부터' : '전체'}  (커밋 ${commits.length}건)`)
  console.log('')

  if (linked.length) {
    console.log(`이어 붙인 것 ${linked.length}건`)
    for (const l of linked) console.log('  ' + l)
    console.log('')
  } else {
    console.log('새로 이어 붙일 것 없음')
    console.log('')
  }

  if (recorded.length) {
    console.log(`기록만 한 커밋이라 완료로 안 찍은 것 ${recorded.length}건`)
    for (const l of recorded) console.log('  ' + l)
    console.log('  → 진행 데이터만 바뀐 커밋입니다. 커밋은 이어 붙였습니다.')
    console.log('')
  }

  if (paired.length) {
    console.log(`QA 회차와 짝지어 만든 릴리즈 회차 ${paired.length}건 (대기)`)
    for (const l of paired) console.log('  ' + l)
    console.log('  → 다시 main 에 나가면 여기 배포 태그가 적힙니다.')
    console.log('')
  }

  if (lateTag.length) {
    console.log(`머지 뒤에 붙인 태그를 채운 것 ${lateTag.length}건`)
    for (const l of lateTag) console.log('  ' + l)
    console.log('')
  }

  if (dropped.length) {
    console.log(`채울 배포가 없어 지운 릴리즈 회차 ${dropped.length}건`)
    for (const l of dropped) console.log('  ' + l)
    console.log('')
  }

  if (fixedRel.length) {
    console.log(`옛 배포 기록을 채운 것 ${fixedRel.length}건`)
    for (const l of fixedRel) console.log('  ' + l)
    console.log('')
  }

  if (reship.length) {
    console.log(`다시 배포되어 릴리즈 회차를 만든 것 ${reship.length}건`)
    for (const l of reship) console.log('  ' + l)
    console.log('')
  }

  if (shipped.length) {
    console.log(`배포 완료로 넘긴 일감 ${shipped.length}건`)
    for (const l of shipped) console.log('  ' + l)
    console.log('')
  }

  if (moved.length) {
    console.log(`칸을 옮긴 일감 ${moved.length}건`)
    for (const l of moved) console.log('  ' + l)
    console.log('')
  }

  if (badRound.size) {
    console.log(`⚠️ 회차를 잘못 붙인 코드 ${badRound.size}개`)
    for (const c of badRound) console.log('  ' + c)
    console.log('  → 셋째 자리(회차)는 QA 와 RL 에만 씁니다. (docs/기능정의서.md)')
    console.log('')
  }

  if (missingCode.size) {
    console.log(`⚠️ 칸반에 없는 코드 ${missingCode.size}개`)
    for (const [code, c] of missingCode) console.log(`  ${code}  ${c.hash}  ${c.subject}`)
    console.log('  → 코드를 잘못 적었거나, 그 칸(또는 QA 회차)을 아직 안 만들었습니다.')
    console.log('')
  }

  if (unlinked.length) {
    console.log(`⚠️ 아직 정리 안 된 커밋 ${unlinked.length}건`)
    for (const c of unlinked) console.log(`  ${c.hash}  ${c.date}  ${c.subject}`)
    console.log('  → 어느 일감인지 정해 주세요.')
  } else {
    console.log('정리 안 된 커밋 없음')
  }

  /* 뺀 것을 아주 감추지는 않는다. 몇 건인지는 늘 보인다. */
  if (IGNORE.size) {
    console.log(`  (일부러 뺀 커밋 ${IGNORE.size}건 — kanban.json 의 ignoredCommits)`)
  }

  if (WRITE) {
    /* ⚠️ 잠금은 20초가 지나면 뺏긴다. 여기 오기까지가 그보다 길었다면 그 사이에
       칸반 화면이 파일을 고쳤을 수 있다. 그대로 쓰면 그 수정이 지워진다.
       파일이 열 때와 같은지 다시 보고, 달라졌으면 아무것도 안 고치고 멈춘다. */
    lockStamp(lock)
    let onDisk = null
    try { onDisk = JSON.parse(fs.readFileSync(DATA, 'utf8')).updatedAt } catch (e) { /* 못 읽으면 그냥 쓴다 */ }
    if (onDisk !== null && onDisk !== openedAt) {
      console.log('')
      console.error('돌리는 사이에 kanban.json 이 밖에서 바뀌었습니다. 아무것도 안 고쳤습니다.')
      console.error('  → 다른 세션이나 칸반 화면이 저장한 것입니다. 다시 돌려 주세요.')
      process.exit(1)
    }

    b.updatedAt = new Date().toISOString()
    fs.writeFileSync(DATA, JSON.stringify(b, null, 2) + '\n', 'utf8')
    console.log('')
    console.log('kanban.json 에 반영했습니다. 칸반을 새로고침(F5)하면 보입니다.')
    console.log('진행표도 다시 쓰려면: node pm/make-report.js --write')
  } else {
    console.log('')
    console.log('(보기만 했습니다. 반영하려면 --write 를 붙여 주세요)')
  }
}

main()

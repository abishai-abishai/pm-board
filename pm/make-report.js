#!/usr/bin/env node
/**
 * pm/make-report.js — 칸반(pm/kanban.json)에서 사람이 읽는 진행표를 만든다.
 *
 *   node pm/make-report.js            무엇이 나올지 앞부분만 보여 준다
 *   node pm/make-report.js --write    pm/진행표.md 를 다시 쓴다
 *
 * ⚠️ 왜 마크다운이 따로 필요한가
 *    git diff 가 JSON 이면 눈으로 안 읽힌다. 사람에게 보여줄 것도 md 쪽이다.
 *    그래서 정본은 kanban.json 이고, 이 파일은 거기서 나온 사본이다.
 *    손으로 고치면 다음 실행 때 덮어써진다.
 *
 * 2026-08-28 에 옛 진행표(board.html 이 만들던 단계별 목록)를 버리고 새로 짰다.
 * 옛것은 섹션 > 화면 > 단계 5개 > 작업 순서였고, 일감 하나가 다섯 자리에 흩어져
 * 무엇이 어디까지 갔는지 한눈에 안 보였다. (docs/기능정의서.md)
 */

'use strict'

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DATA = path.join(ROOT, 'pm', 'kanban.json')
const OUT = path.join(ROOT, 'pm', '진행표.md')
const WRITE = process.argv.includes('--write')

const COLS = [
  { key: 'plan',    name: '기획' },
  { key: 'dev',     name: '개발' },
  { key: 'qa',      name: 'QA' },
  { key: 'wait',    name: '릴리즈 대기' },
  { key: 'done',    name: '배포 완료' },
]
/* fixed(수정 완료)는 QA 칸에만 나온다. 고치기는 끝났고 검증이 남았다는 뜻이다.
   완료가 아니므로 그 일감은 QA 칸에 그대로 선다. (docs/기능정의서.md) */
const MARK = { idle: '⬜', doing: '⏳', fixed: '🔧', done: '✅', block: '⏸' }
const SNAME = { idle: '대기', doing: '진행 중', fixed: '수정 완료', done: '완료', block: '보류' }

function stepMark(s, unit){
  if (!s) return '·'
  /* 회차가 하나라도 안 끝나면 그 칸은 완료가 아니다. 회차 수를 함께 적는다. */
  const rs = s.rounds || []
  if (rs.length){
    const left = rs.filter(r => r.status !== 'done').length
    const mk = (s.status === 'done' && !left) ? MARK.done : (MARK[s.status] || '⬜')
    return mk + ' ' + (rs.length + 1) + (unit || '회차') + (left ? ' (' + left + ' 남음)' : '')
  }
  return MARK[s.status] || '⬜'
}

/* 개발 칸은 클라·서버 둘이 들어간다. 둘 다 있으면 둘 다 보인다. */
function devMark(j){
  const out = []
  if (j.steps.fe) out.push('클라 ' + stepMark(j.steps.fe))
  if (j.steps.be) out.push('서버 ' + stepMark(j.steps.be))
  return out.length ? out.join(' · ') : '·'
}

/* ⚠️ **마지막 배포**를 적는다. 다시 나갔으면 릴리즈 회차가 붙어 있다. (2026-08-31) */
function shipMark(j){
  const r = j.steps.release
  if (!r || r.status !== 'done') return ''
  const rs = r.rounds || []
  const e = rs.length ? rs[rs.length - 1] : r
  if (e.shippedTag) return e.shippedTag
  return e.shippedAt ? String(e.shippedAt).slice(0, 10) : ''
}

function pad2(n){ return (n < 10 ? '0' : '') + n }

function build(b){
  const L = []
  const now = new Date()
  const stamp = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) +
                ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes())

  L.push('**최종 수정: ' + stamp + ' · ' + (b.docVersion || '4.0.0') + '**')
  L.push('')
  L.push('# ' + (b.project || '프로젝트') + ' 진행 현황')
  L.push('')
  L.push('> ⚠️ **이 파일은 `node pm/make-report.js --write` 가 자동으로 씁니다. 손으로 고치지 마세요.**')
  L.push('> 고치면 다음 실행 때 덮어써집니다. 정본은 `pm/kanban.json` 입니다.')
  L.push('')
  L.push('**일감 하나가 다섯 칸을 왼쪽에서 오른쪽으로 옮겨 갑니다.** 사람이 끌어 옮기지 않습니다.')
  L.push('앞 칸이 완료여야 다음 칸으로 갑니다. 보류는 그 자리에 섭니다. (규칙 정본은 `docs/기능정의서.md`)')
  L.push('')
  L.push('```')
  L.push('기획  →  개발  →  QA  →  릴리즈 대기  →  배포 완료')
  L.push('PL       FE·BE   QA     RL(대기)        RL(완료)')
  L.push('```')
  L.push('')
  L.push('상태 기호: ⬜ 대기 · ⏳ 진행 중 · 🔧 수정 완료(QA 전용, 검증 전) · ✅ 완료 · ⏸ 보류 · `·` 칸 없음')
  L.push('')

  /* ── 지금 어디에 있나 ── */
  const cnt = {}
  COLS.forEach(c => cnt[c.key] = 0)
  ;(b.jobs || []).forEach(j => { if (cnt[j.col] !== undefined) cnt[j.col]++ })

  L.push('## 지금 어디에 있나')
  L.push('')
  L.push('| 칸 | 일감 |')
  L.push('|---|---|')
  COLS.forEach(c => L.push('| ' + c.name + ' | ' + cnt[c.key] + '개 |'))
  L.push('')
  L.push('전체 ' + (b.jobs || []).length + '개.')
  L.push('')

  /* ── 열려 있는 일감 ── */
  const open = (b.jobs || []).filter(j => j.col !== 'done')
  L.push('## 열려 있는 일감')
  L.push('')
  if (!open.length){
    L.push('없습니다. 모두 배포까지 끝났습니다.')
  } else {
    L.push('| 칸 | 일감 | 제목 | 화면 | 남은 것 |')
    L.push('|---|---|---|---|---|')
    open.forEach(j => {
      /* 남은 칸. QA 는 안 끝난 회차가 있으면 그 회차 코드를 적는다. */
      const leftCodes = []
      for (const k of ['plan', 'fe', 'be', 'qa', 'release']){
        const st = j.steps[k]
        if (!st) continue
        const open = (st.rounds || []).filter(r => r.status !== 'done')
        if (open.length){ open.forEach(r => leftCodes.push(r.code)); continue }
        if (st.status !== 'done') leftCodes.push(st.code)
      }
      const left = leftCodes.join(' · ')
      const cn = (COLS.filter(c => c.key === j.col)[0] || {}).name || j.col
      L.push('| ' + cn + ' | `' + j.no + '` | ' + (j.title || '') + ' | ' + j.screen + ' | ' + (left || '칸 없음') + ' |')
    })
  }
  L.push('')

  /* ── 화면별 전체 ── */
  L.push('## 화면별 전체')
  L.push('')
  ;(b.sections || []).forEach(sec => {
    const inSec = (b.jobs || []).filter(j => j.sec === sec.no)
    L.push('### ' + sec.no + ' ' + (sec.title || '') + '  (' + inSec.length + '건'
           + (sec.dueLabel ? ' · ' + sec.dueLabel : '') + ')')
    L.push('')
    if (!inSec.length){
      L.push('아직 일감이 없습니다.')
      L.push('')
      return
    }
    ;(sec.screens || []).forEach(sc => {
      const mine = inSec.filter(j => j.screen === sc.name)
      L.push('#### ' + (sc.name || '(이름 없음)'))
      L.push('')
      if (!mine.length){
        L.push('아직 일감이 없습니다.')
        L.push('')
        return
      }
      L.push('| 일감 | 제목 | 칸 | 기획 | 개발 | QA | 릴리즈 | 배포 |')
      L.push('|---|---|---|---|---|---|---|---|')
      mine.forEach(j => {
        const cn = (COLS.filter(c => c.key === j.col)[0] || {}).name || j.col
        L.push('| `' + j.no + '` | ' + (j.title || '') + ' | ' + cn + ' | '
             + stepMark(j.steps.plan) + ' | ' + devMark(j) + ' | '
             + stepMark(j.steps.qa) + ' | ' + stepMark(j.steps.release, '차 배포') + ' | '
             + (shipMark(j) || '') + ' |')
      })
      L.push('')
    })
  })

  /* ── 정리 안 된 커밋 ── */
  const un = b.unlinked || []
  L.push('## 정리 안 된 커밋')
  L.push('')
  if (!un.length){
    L.push('없습니다.')
  } else {
    L.push('작업 코드가 없어 어느 일감에도 안 붙은 커밋입니다. 어느 일감인지 정해 주세요.')
    L.push('')
    L.push('| 날짜 | 커밋 | 제목 |')
    L.push('|---|---|---|')
    un.forEach(c => L.push('| ' + c.date + ' | `' + c.hash + '` | ' + c.subject + ' |'))
  }
  L.push('')

  L.push('---')
  L.push('')
  L.push('만드는 법')
  L.push('')
  L.push('```')
  L.push('node pm/sync-commits.js --write    커밋을 칸반에 붙인다')
  L.push('node pm/make-report.js --write     이 문서를 다시 쓴다')
  L.push('```')
  L.push('')
  L.push('화면으로 보려면 `pm/kanban.html` 을 브라우저로 엽니다.')
  L.push('')

  return L.join('\n')
}

function main(){
  if (!fs.existsSync(DATA)){
    console.error('kanban.json 을 찾지 못했습니다: ' + DATA)
    process.exit(1)
  }
  const b = JSON.parse(fs.readFileSync(DATA, 'utf8'))
  if (!b.jobs){
    console.error('kanban.json 이 옛 구조입니다. jobs 가 없습니다.')
    process.exit(1)
  }
  const md = build(b)

  if (WRITE){
    fs.writeFileSync(OUT, md, 'utf8')
    console.log('pm/진행표.md 를 다시 썼습니다. (' + md.split('\n').length + '줄)')
  } else {
    console.log(md.split('\n').slice(0, 40).join('\n'))
    console.log('')
    console.log('... 모두 ' + md.split('\n').length + '줄')
    console.log('(보기만 했습니다. 쓰려면 --write 를 붙여 주세요)')
  }
}

main()

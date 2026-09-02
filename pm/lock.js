#!/usr/bin/env node
/**
 * pm/lock.js — kanban.json 을 고치기 전에 잡는 잠금. (2026-09-01 결정 사항)
 *
 * 왜 있나
 *   kanban.json 을 PO 는 스크립트로, PM 은 브라우저(kanban.html)에서 고친다.
 *   둘이 겹치면 나중에 저장한 쪽이 먼저 것을 덮어쓴다.
 *   2026-08-27 에 실제로 커밋 30건과 repoUrl 이 그렇게 사라졌다. (docs/기능정의서.md)
 *
 * ⚠️ 잠금을 kanban.json 안에 두지 않는다.
 *    잠금을 잡는 행위가 곧 그 파일을 쓰는 것이라, 두 쪽이 같이 "비어 있네" 하고
 *    각자 써 버리면 막으려던 사고가 그대로 난다. 지키려는 파일과 잠금 파일을 가른다.
 *
 * 잠금 파일  pm/kanban.lock
 *   { "by": "PM", "id": "l8f3k2a9", "at": "2026-09-01T09:12:00.000Z" }
 *
 *   by  누가 잡았나 (PO · PM · 클라 · 서버). 사람이 읽으려고 적는다
 *   id  이번에 잡은 것만 가리키는 표. **이것이 없으면 잠금이 성립하지 않는다.**
 *       내가 쓴 뒤 다시 읽어 내 id 가 남아 있어야 내가 이긴 것이다.
 *       by 만으로는 같은 쪽 창이 둘일 때 서로를 못 가린다
 *   at  잡은 시각. 여기서 20초가 지나면 그 세션이 멈췄다고 보고 뺏는다
 *
 * 쓰는 법
 *   import { acquire, release, stamp } from './lock.js'
 *   const lock = acquire('PO')
 *   if (!lock) { ...  포기하고 사람에게 알린다 }
 *   try { ... kanban.json 을 읽고 고치고 쓴다 ... } finally { release(lock) }
 *
 * ⚠️ 이 잠금만으로는 모자란다. 잡고 있는 동안에도 만료(20초)로 뺏길 수 있고,
 *    그때 상대가 파일을 고친다. **쓰기 직전에 updatedAt 이 그대로인지 다시 본다.**
 *    fresh() 가 그것을 본다. 잠금은 겹침을 줄이고, updatedAt 이 마지막 관문이다.
 *
 * ⚠️ kanban.html 안에도 같은 알고리즘이 한 벌 더 있다. 브라우저는 이 파일을
 *    불러올 수 없고(File System Access API 로만 파일에 닿는다) 값과 순서가
 *    같아야 서로를 알아본다. **한쪽을 고치면 다른 쪽도 같이 고친다.**
 *    kanban.html 의 lockAcquire 를 보라.
 */

'use strict'

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCKFILE = path.join(HERE, 'kanban.lock')

/* 20초가 지난 잠금은 그 세션이 멈춘 것으로 보고 뺏는다. 팀에서 정한 값이다.
   sync-commits.js 한 번이 실측 2초라 20초 안에 끝난다. */
export const TTL = 20000
/* 쓴 뒤 이만큼 두었다가 다시 읽어 내 것이 남았는지 본다.
   상대가 거의 같은 순간에 썼다면 이 사이에 드러난다. */
const SETTLE = 150
/* 남이 잡고 있으면 이 주기로 풀렸는지 다시 본다.
   ⚠️ 만료(20초)까지 통째로 기다리지 않는다. 상대는 대개 1초 안에 끝내고 푸는데
      20초를 자면 그만큼 헛기다린다. 2026-09-01 실측 — 3초 만에 풀린 잠금을
      20.1초 기다려 잡았다. 이 화면은 글자를 칠 때마다 저장하므로 그동안 멈춘다. */
const POLL = 300
/* 여기까지 못 잡으면 포기하고 사람에게 알린다. */
const WAIT_MAX = 60000

function sleep(ms) {
  if (ms <= 0) return
  /* Node 에서 기다리는 동안 아무것도 안 하게 막는다. main() 이 동기라 async 를 못 쓴다. */
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function token() {
  return Math.random().toString(36).slice(2, 10)
}

function readLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCKFILE, 'utf8'))
    if (!cur || !cur.id) return null
    return cur
  } catch (e) {
    /* 파일이 없거나 쓰는 도중이라 깨져 보이면 안 걸린 것으로 본다.
       깨진 채 남아 있어도 다음 사람이 덮어써서 저절로 풀린다. */
    return null
  }
}

function ageOf(cur) {
  const t = Date.parse(cur.at)
  if (!Number.isFinite(t)) return TTL + 1
  return Date.now() - t
}

/**
 * 잠금을 잡는다. 잡으면 { by, id, at } 을, 못 잡으면 null 을 준다.
 * @param {string} who  PO · PM · 클라 · 서버
 */
export function acquire(who) {
  const id = token()
  const giveUp = Date.now() + WAIT_MAX
  for (;;) {
    const cur = readLock()
    if (cur && cur.id !== id && ageOf(cur) < TTL) {
      /* 남이 잡고 있고 아직 안 만료됐다. 풀렸는지 짧게짧게 다시 본다. */
      if (Date.now() >= giveUp) return null
      sleep(POLL)
      continue
    }
    const mine = { by: who, id, at: new Date().toISOString() }
    try {
      fs.writeFileSync(LOCKFILE, JSON.stringify(mine) + '\n', 'utf8')
    } catch (e) {
      return null
    }
    sleep(SETTLE)
    const after = readLock()
    if (after && after.id === id) return mine
    /* 상대가 거의 같은 순간에 썼고 그쪽이 뒤였다. 양보하고 다시 본다. */
    if (Date.now() >= giveUp) return null
  }
}

/** 잠금 시각을 지금으로 다시 찍는다. 오래 도는 작업이 만료로 뺏기지 않게 한다. */
export function stamp(mine) {
  if (!mine) return false
  const cur = readLock()
  if (cur && cur.id !== mine.id) return false
  mine.at = new Date().toISOString()
  try {
    fs.writeFileSync(LOCKFILE, JSON.stringify(mine) + '\n', 'utf8')
    return true
  } catch (e) {
    return false
  }
}

/** 잠금을 푼다. ⚠️ 내 것일 때만 지운다. 뺏긴 뒤라면 남의 잠금이라 손대지 않는다. */
export function release(mine) {
  if (!mine) return
  const cur = readLock()
  if (cur && cur.id !== mine.id) return
  try { fs.unlinkSync(LOCKFILE) } catch (e) { /* 이미 없으면 그만이다 */ }
}

/** 잠금을 못 잡았을 때 사람에게 보여 줄 글. 누가 잡고 있는지 적는다. */
export function busyMessage() {
  const cur = readLock()
  const who = cur && cur.by ? cur.by : '다른 세션'
  return who + ' 이(가) 지금 kanban.json 을 고치고 있어 손대지 않았습니다.\n'
    + '  → 잠시 뒤에 다시 돌려 주세요.'
}

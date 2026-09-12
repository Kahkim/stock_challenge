'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

/**
 * 방 상태를 디스크에 저장하고 복구한다.
 *
 * 15분짜리 행사 중에 서버가 죽으면 진행 중인 게임이 통째로 사라진다.
 * 주기적으로 저장해 두면 재시작 후 그 지점부터 이어갈 수 있다.
 *
 * 파일은 항상 임시 파일에 쓰고 rename 으로 바꾼다. 쓰는 도중에 죽어도
 * 반쯤 쓰인 파일이 남지 않는다.
 */

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function saveRoom(room, dir) {
  const file = path.join(dir, room.code + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(room.serialize()));
  fs.renameSync(tmp, file);
}

/**
 * 진행 중인 방을 전부 저장한다(동기). 종료 직전처럼 끝까지 기다려야 할 때만 쓴다.
 * 평상시 주기 저장은 saveAllAsync 를 쓴다 — 동기 I/O 는 이벤트 루프를 막아
 * 게임 틱과 SSE 전송이 그만큼 밀린다.
 */
function saveAll(store, dir) {
  ensureDir(dir);
  let n = 0;
  const keep = new Set();
  for (const room of store.rooms.values()) {
    try { saveRoom(room, dir); keep.add(room.code + '.json'); n++; }
    catch (e) { console.error('[persist] 저장 실패', room.code, e.message); }
  }
  cleanup(dir, keep);
  return n;
}

/** 평상시 주기 저장. 방 하나마다 이벤트 루프에 양보한다. */
async function saveAllAsync(store, dir) {
  ensureDir(dir);
  let n = 0;
  const keep = new Set();
  for (const room of store.rooms.values()) {
    try {
      const body = JSON.stringify(room.serialize());
      const file = path.join(dir, room.code + '.json');
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, file);
      keep.add(room.code + '.json');
      n++;
    } catch (e) { console.error('[persist] 저장 실패', room.code, e.message); }
  }
  cleanup(dir, keep);
  return n;
}

/** 사라진 방의 파일과 남은 임시 파일을 지운다 */
function cleanup(dir, keep) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json') && !keep.has(f)) fs.unlinkSync(path.join(dir, f));
      else if (f.endsWith('.tmp')) fs.unlinkSync(path.join(dir, f));
    }
  } catch (_) {}
}

/** 저장된 방을 전부 되살린다. 되살린 방 수를 반환. */
function loadAll(store, dir, RoomClass) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    try {
      const room = RoomClass.restore(JSON.parse(fs.readFileSync(file, 'utf8')));
      store.rooms.set(room.code, room);
      n++;
    } catch (e) {
      // 깨진 파일 하나가 서버 기동을 막으면 안 된다. 옆으로 치우고 계속한다.
      console.error('[persist] 복구 실패', f, e.message);
      try { fs.renameSync(file, file + '.broken'); } catch (_) {}
    }
  }
  return n;
}

module.exports = { saveAll, saveAllAsync, loadAll, saveRoom, ensureDir };

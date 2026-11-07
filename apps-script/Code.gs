/**
 * 바자회 POS → 구글 스프레드시트 자동 기록
 * ---------------------------------------------------------------------------
 * 바자회 전용 **새 스프레드시트**에 붙여 쓴다. 탭과 머리글은 `시트_만들기` 가 만든다.
 *
 *   판매기록  원본(원장). 앱이 판매 · 반품 · 입고 · 재고조정을 상품 한 줄씩 적는다.
 *   요약      수식만 있는 화면. 판매기록 · 예약을 읽어 합계와 상품별 표를 보여 준다.
 *   예약      예약 대장. 예약 한 건 = 한 줄. 입금 · 수령이 바뀌면 **그 줄을 그 자리에서** 고친다.
 *   _전송기록 (숨김) 이미 적은 기록ID. 같은 거래를 두 번 보내도 한 번만 적힌다.
 *   _거절기록 (숨김) 시트가 받지 못한 기록과 이유.
 *
 * 판매기록 한 줄의 규칙 (앱이 만들고, 앱의 '시트 대조' 가 다시 확인한다):
 *   금액 = 단가 × 수량 − 할인,  현금 + 계좌이체 = 금액
 *   반품은 수량 · 할인 · 금액 · 현금 · 계좌이체가 음수 → 열을 그냥 SUM 하면 순매출이 된다.
 *
 * ⚠ 판매기록에 손으로 줄을 적거나 고치지 마세요. 기록ID 가 있는 줄은 앱이 관리합니다.
 *   (앱의 '시트 대조' 가 다른 점을 찾아 알려 주고, '고치기' 로 앱 기준으로 되돌립니다)
 *
 * 설치
 *   1) 구글 드라이브 → 새 스프레드시트 (예: "바자회 판매기록 2026-11-08")
 *   2) 확장 프로그램 → Apps Script → 이 파일 내용을 통째로 붙여넣고 저장
 *   3) 위쪽 함수 목록에서 `시트_만들기` 실행 (처음엔 권한 승인 창이 뜬다 → 허용)
 *   4) `토큰_만들기` 실행 → 실행 로그에 찍힌 토큰을 복사
 *   5) 배포 → 새 배포 → 유형 '웹 앱' / 실행: 나 / 액세스: 모든 사용자
 *      → 생성된 /exec 주소를 복사
 *   6) 앱 ⚙ 설정 → 🔗 시트 연동 에 주소와 토큰을 넣고 저장
 *
 * 코드를 고친 뒤에는 '배포 관리 → ✏️ → 버전: 새 버전' 으로 다시 배포해야 반영된다.
 * ('새 배포' 를 만들면 주소가 바뀐다)
 */

/* 앱(ledger.js)의 MIRROR_VERSION 과 같아야 한다. 이 파일을 고치면 둘 다 올린다. */
var MIRROR_VERSION = '2026-11-08a';

var LEDGER_TAB = '판매기록';
var SUMMARY_TAB = '요약';
var ORDER_TAB = '예약';
var SENT_TAB = '_전송기록';
var REJECT_TAB = '_거절기록';
var TOKEN_KEY = 'MIRROR_TOKEN';

var LEDGER_HEADERS = ['날짜', '시각', '상품명', '구분', '수량', '단가', '할인', '금액',
                      '결제방식', '현금', '계좌이체', '고객명', '연락처', '비고', '기록ID'];
var ORDER_HEADERS = ['예약번호', '등록일시', '성함', '연락처', '주문내역', '수량', '금액',
                     '결제수단', '입금', '수령', '메모', '기록ID', '수정순번'];
var LEDGER_TEXT = ['상품명', '구분', '결제방식', '고객명', '연락처', '비고', '기록ID'];
var ORDER_TEXT = ['성함', '연락처', '주문내역', '결제수단', '입금', '수령', '메모', '기록ID'];

var DATE_FMT = 'yyyy-mm-dd';
var TIME_FMT = 'HH:mm:ss';
var STAMP_FMT = 'yyyy-mm-dd HH:mm';
var MONEY_FMT = '#,##0;-#,##0;""';
var QTY_FMT = '0;-0;0';
var LEDGER_FMTS = { 날짜: DATE_FMT, 시각: TIME_FMT, 수량: QTY_FMT, 단가: MONEY_FMT, 할인: MONEY_FMT,
                    금액: MONEY_FMT, 현금: MONEY_FMT, 계좌이체: MONEY_FMT };
var ORDER_FMTS = { 예약번호: '0', 등록일시: STAMP_FMT, 수량: QTY_FMT, 금액: MONEY_FMT, 수정순번: '0' };

/* ===================== 웹앱 진입점 ===================== */

function doGet() {
  return json({ ok: true, service: '바자회 POS 시트 기록' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body.token || body.token !== scriptToken()) {
      return json({ ok: false, error: '토큰이 맞지 않습니다. 앱 설정의 토큰을 확인하세요.' });
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.action === 'ping') return json({ ok: true, sheet: ss.getName() });
    if (body.action === 'verify') return json(readForVerify(ss));
    if (body.action === 'reset') return withLock(function (ss) { return resetAppRows(ss); });
    if (body.action === 'ops') return withLock(function (ss) { return applyOps(ss, body.ops || []); });
    return json({ ok: false, error: '알 수 없는 요청입니다: ' + body.action });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/* 동시에 두 요청이 같은 줄에 쓰지 않게 잠근다. 잠금을 풀기 **전에** flush 해야
   바로 뒤 요청이 방금 적은 _전송기록 을 본다 (안 그러면 같은 거래가 두 번 적힐 수 있다). */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var out = fn(SpreadsheetApp.getActiveSpreadsheet());
    SpreadsheetApp.flush();
    return json(out);
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  obj.version = MIRROR_VERSION;
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ===================== 기록 적용 =====================
   ops 는 앱이 넣은 순서대로 하나씩 적용한다. 하나가 실패해도 나머지는 계속한다.
   결과는 op 마다 { key, ok, error? } — 앱은 ok 인 것만 큐에서 지운다.

   op 종류
     rows      { key, records }           새 줄 (기록ID=key). 이미 적은 key 면 건너뛴다.
     delete    { key, target }            target 기록ID 줄을 지우고, 다시는 안 적게 표시한다.
     replace   { key, target, records }   target 줄을 지우고 records 로 다시 적는다 (대조 후 고치기).
     order     { key, id, rev, record }   예약 한 줄을 넣거나 그 자리에서 고친다 (rev 가 더 새것일 때만).
     orderdel  { key, id }                예약 줄을 지우고, 늦게 온 고치기가 되살리지 못하게 표시한다.
     rename    { key, from, to }          앱이 적은 줄의 상품명을 바꾼다 (상품 이름을 고쳤을 때). */
function applyOps(ss, ops) {
  var sent = sentKeys(ss);
  var results = [];
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i] || {};
    var key = String(op.key || '');
    try {
      if (!key) throw new Error('기록ID 가 없습니다.');
      var r = applyOne(ss, op, sent) || {};
      r.key = key;
      r.ok = true;
      results.push(r);
    } catch (err) {
      var msg = String(err && err.message || err);
      results.push({ key: key, ok: false, error: msg });
      logRejected(ss, key, msg);
    }
  }
  return { ok: true, results: results };
}

function applyOne(ss, op, sent) {
  switch (op.op) {
    case 'rows': {
      if (sent[op.key]) return { skipped: true };
      var n = appendLedger(ss, op.key, op.records || []);
      markSent(ss, sent, op.key);
      return { written: n };
    }
    case 'delete': {
      var removed = deleteByKey(ss.getSheetByName(LEDGER_TAB), op.target);
      markSent(ss, sent, op.target);               // 늦게 도착한 원래 줄이 되살아나지 않게
      return { removed: removed };
    }
    case 'replace': {
      var gone = deleteByKey(ss.getSheetByName(LEDGER_TAB), op.target);
      var w = (op.records && op.records.length) ? appendLedger(ss, op.target, op.records) : 0;
      markSent(ss, sent, op.target);
      return { removed: gone, written: w };
    }
    case 'order': {
      if (sent['orderdel:' + op.id]) return { skipped: true };
      return upsertOrder(ss, op);
    }
    case 'orderdel': {
      var rm = deleteByKey(ss.getSheetByName(ORDER_TAB), 'order:' + op.id);
      markSent(ss, sent, 'orderdel:' + op.id);
      return { removed: rm };
    }
    case 'rename':
      return { renamed: renameProduct(ss, op.from, op.to) };
    default:
      throw new Error('알 수 없는 기록 종류입니다: ' + op.op);
  }
}

/* ---------- 판매기록에 줄 붙이기 ----------
   쓰자마자 flush 해서, 누가 시트에 입력 규칙을 걸어 둬 거절되면 **여기서** 터지게 한다.
   터지면 방금 쓴 칸을 지우고 오류를 올린다 — 반쯤 써진 줄이 남지 않는다. */
function appendLedger(ss, key, records) {
  if (!records.length) throw new Error('적을 줄이 없습니다.');
  var sheet = needSheet(ss, LEDGER_TAB);
  var h = headerMap(sheet, LEDGER_HEADERS);
  var values = records.map(function (rec) { return rowFor(h, rec, key, LEDGER_TEXT); });
  var start = lastFilledRow(sheet, h.col['상품명']) + 1;
  ensureRows(sheet, start + values.length - 1, LEDGER_HEADERS, LEDGER_FMTS, LEDGER_TEXT);
  var target = sheet.getRange(start, 1, values.length, h.width);
  try {
    target.setValues(values);
    SpreadsheetApp.flush();
  } catch (err) {
    try { target.clearContent(); SpreadsheetApp.flush(); } catch (e2) {}
    throw err;
  }
  return values.length;
}

/* 기록 하나 → 머리글 순서의 한 줄. 열은 이름으로 찾는다. */
function rowFor(h, rec, key, textCols) {
  var row = [];
  for (var i = 0; i < h.width; i++) row.push('');
  Object.keys(rec).forEach(function (name) {
    var c = h.col[name];
    if (!c) throw new Error('시트에 "' + name + '" 열이 없습니다. 시트_만들기 를 다시 실행하세요.');
    row[c - 1] = cellValue(rec[name], textCols.indexOf(name) !== -1);
  });
  row[h.col['기록ID'] - 1] = key;
  return row;
}

/* 글자 칸에 '=' '+' '-' '@' 로 시작하는 말이 오면 시트가 수식으로 읽는다 — 앞에 ' 를 붙여 글자로 둔다 */
function cellValue(v, isText) {
  if (v === null || v === undefined) return '';
  if (!isText) return v;
  var s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/* ---------- 예약 한 줄 넣기 / 그 자리에서 고치기 ---------- */
function upsertOrder(ss, op) {
  var sheet = needSheet(ss, ORDER_TAB);
  var h = headerMap(sheet, ORDER_HEADERS);
  var key = 'order:' + op.id;
  var row = findRowByKey(sheet, h, key);
  var rev = Number(op.rev) || 0;
  if (row) {
    var have = Number(sheet.getRange(row, h.col['수정순번']).getValue()) || 0;
    if (have > rev) return { skipped: true };        // 이미 더 새것이 적혀 있다
  }
  var values = rowFor(h, op.record || {}, key, ORDER_TEXT);
  values[h.col['수정순번'] - 1] = rev;
  var at = row || (lastFilledRow(sheet, h.col['기록ID']) + 1);
  if (!row) ensureRows(sheet, at, ORDER_HEADERS, ORDER_FMTS, ORDER_TEXT);
  var target = sheet.getRange(at, 1, 1, h.width);
  var before = row ? target.getValues() : null;
  try {
    target.setValues([values]);
    SpreadsheetApp.flush();
  } catch (err) {
    try { if (before) target.setValues(before); else target.clearContent(); SpreadsheetApp.flush(); } catch (e2) {}
    throw err;
  }
  return { written: 1, updated: !!row };
}

/* ---------- 지우기 · 이름 바꾸기 ----------
   기록ID 가 정확히 같은 줄만 건드린다. 손으로 적은 줄(기록ID 빈칸)은 절대 안 건드린다. */
function deleteByKey(sheet, key) {
  if (!sheet || !key) return 0;
  var h = headerMap(sheet, null);
  var c = h.col['기록ID'];
  if (!c) return 0;
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var vals = sheet.getRange(2, c, last - 1, 1).getValues();
  var removed = 0;
  for (var i = vals.length - 1; i >= 0; i--) {         // 아래부터 지워야 행 번호가 안 밀린다
    if (String(vals[i][0]) === String(key)) { sheet.deleteRow(i + 2); removed++; }
  }
  return removed;
}

function findRowByKey(sheet, h, key) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var vals = sheet.getRange(2, h.col['기록ID'], last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === key) return i + 2;
  return 0;
}

function renameProduct(ss, from, to) {
  from = String(from || '').trim(); to = String(to || '').trim();
  if (!from || !to) throw new Error('바꿀 상품명이 비어 있습니다.');
  var sheet = needSheet(ss, LEDGER_TAB);
  var h = headerMap(sheet, LEDGER_HEADERS);
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var names = sheet.getRange(2, h.col['상품명'], last - 1, 1).getValues();
  var keys = sheet.getRange(2, h.col['기록ID'], last - 1, 1).getValues();
  var n = 0;
  for (var i = 0; i < names.length; i++) {
    if (keys[i][0] && String(names[i][0]).trim() === from) {
      sheet.getRange(i + 2, h.col['상품명']).setValue(cellValue(to, true));
      n++;
    }
  }
  return n;
}

/* ===================== 대조용 읽기 =====================
   기록ID 가 있는 줄만 돌려준다. 날짜·시각은 시트가 **화면에 보여 주는 글자** 그대로,
   나머지는 값 그대로 — 앱이 자기 기록과 한 칸씩 비교한다. */
function readForVerify(ss) {
  return { ok: true, ledger: readKeyed(ss, LEDGER_TAB, ['날짜', '시각']),
           orders: readKeyed(ss, ORDER_TAB, ['등록일시']),
           handRows: countHandRows(ss) };
}

function readKeyed(ss, name, displayCols) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('"' + name + '" 탭이 없습니다. 시트_만들기 를 실행하세요.');
  var h = headerMap(sheet, null);
  var last = sheet.getLastRow();
  if (last < 2 || !h.col['기록ID']) return [];
  var range = sheet.getRange(2, 1, last - 1, h.width);
  var vals = range.getValues(), disp = range.getDisplayValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var key = String(vals[i][h.col['기록ID'] - 1] || '');
    if (!key) continue;
    var rec = {};
    Object.keys(h.col).forEach(function (n) {
      var c = h.col[n] - 1;
      rec[n] = displayCols.indexOf(n) !== -1 ? disp[i][c] : vals[i][c];
    });
    out.push({ key: key, rec: rec });
  }
  return out;
}

/* 기록ID 없이 손으로 적힌 줄 — 앱 합계와 시트 합계가 달라지는 원인이라 숫자를 알려 준다 */
function countHandRows(ss) {
  var sheet = ss.getSheetByName(LEDGER_TAB);
  if (!sheet) return 0;
  var h = headerMap(sheet, null);
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var vals = sheet.getRange(2, 1, last - 1, h.width).getValues();
  var n = 0;
  vals.forEach(function (r) {
    var any = r.some(function (v, i) { return i !== h.col['기록ID'] - 1 && v !== '' && v !== null; });
    if (any && !r[h.col['기록ID'] - 1]) n++;
  });
  return n;
}

/* ===================== 전체 초기화 (앱의 '전체 초기화' 가 부른다) =====================
   앱이 적은 줄(기록ID 있음)만 지운다. 손으로 적은 줄과 요약 수식은 그대로 둔다. */
function resetAppRows(ss) {
  var removed = 0;
  [LEDGER_TAB, ORDER_TAB].forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    var h = headerMap(sheet, null);
    var last = sheet.getLastRow();
    if (last < 2 || !h.col['기록ID']) return;
    var vals = sheet.getRange(2, h.col['기록ID'], last - 1, 1).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      if (vals[i][0]) { sheet.deleteRow(i + 2); removed++; }
    }
  });
  var sent = ss.getSheetByName(SENT_TAB);
  if (sent && sent.getLastRow() > 1) sent.getRange(2, 1, sent.getLastRow() - 1, 2).clearContent();
  return { ok: true, removed: removed };
}

/* ===================== 도우미 ===================== */

function needSheet(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('"' + name + '" 탭이 없습니다. Apps Script 에서 시트_만들기 를 실행하세요.');
  return sh;
}

/* 1행 머리글 → 이름: 열번호. want 가 있으면 빠진 열이 없는지 확인한다. */
function headerMap(sheet, want) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var cells = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v).trim(); });
  var col = {}, width = 0;
  cells.forEach(function (n, i) { if (n && !col[n]) { col[n] = i + 1; width = i + 1; } });
  if (want) {
    var miss = want.filter(function (n) { return !col[n]; });
    if (miss.length) throw new Error('"' + sheet.getName() + '" 탭 머리글에 ' + miss.join(', ') +
      ' 열이 없습니다. 머리글을 지우거나 고치지 마세요 (시트_만들기 를 다시 실행하면 복구됩니다).');
  }
  return { col: col, width: width };
}

/* 시트는 처음에 1000줄뿐이다. 넘어가면 getRange 가 터지므로 미리 늘리고, 늘린 줄에도 서식을 건다 */
function ensureRows(sheet, lastNeeded, headers, fmts, textCols) {
  var max = sheet.getMaxRows();
  if (lastNeeded <= max) return;
  sheet.insertRowsAfter(max, lastNeeded - max + 500);
  if (headers) formatCols(sheet, headers, fmts, textCols);
}

/* 실제로 값이 적힌 마지막 줄 (getLastRow 는 서식만 있는 빈 줄도 센다) */
function lastFilledRow(sheet, col) {
  var last = sheet.getLastRow();
  if (last < 2) return 1;
  var vals = sheet.getRange(2, col, last - 1, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) if (String(vals[i][0]).trim()) return i + 2;
  return 1;
}

function sentSheet(ss) {
  var sh = ss.getSheetByName(SENT_TAB);
  if (!sh) {
    sh = ss.insertSheet(SENT_TAB);
    sh.getRange(1, 1, 1, 2).setValues([['기록ID', '적은 시각']]);
    sh.hideSheet();
  }
  return sh;
}
function sentKeys(ss) {
  var sh = sentSheet(ss);
  var n = sh.getLastRow() - 1;
  var map = {};
  if (n > 0) sh.getRange(2, 1, n, 1).getValues().forEach(function (r) { if (r[0]) map[String(r[0])] = true; });
  return map;
}
function markSent(ss, sent, key) {
  if (sent[key]) return;
  var sh = sentSheet(ss);
  var at = lastFilledRow(sh, 1) + 1;
  ensureRows(sh, at, null);
  sh.getRange(at, 1, 1, 2).setValues([[key, new Date()]]);
  SpreadsheetApp.flush();
  sent[key] = true;
}

function logRejected(ss, key, msg) {
  try {
    var sh = ss.getSheetByName(REJECT_TAB);
    if (!sh) {
      sh = ss.insertSheet(REJECT_TAB);
      sh.getRange(1, 1, 1, 3).setValues([['시각', '기록ID', '이유']]);
      sh.hideSheet();
    }
    ensureRows(sh, sh.getLastRow() + 1, null);
    sh.getRange(sh.getLastRow() + 1, 1, 1, 3).setValues([[new Date(), key, msg]]);
  } catch (e) {}
}

function scriptToken() {
  return PropertiesService.getScriptProperties().getProperty(TOKEN_KEY);
}

/* ===================== 직접 실행하는 함수 ===================== */

function 토큰_만들기() {
  var token = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(TOKEN_KEY, token);
  Logger.log('토큰이 만들어졌습니다. 앱 ⚙ 설정 → 시트 연동 에 이 값을 넣으세요:\n\n' + token);
}

/* 탭 · 머리글 · 서식 · 요약 수식을 만든다. 여러 번 실행해도 안전하다 —
   이미 있는 탭의 데이터는 건드리지 않고, 빠진 머리글과 수식만 채운다. */
function 시트_만들기() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Seoul');

  var led = makeTab(ss, LEDGER_TAB, LEDGER_HEADERS, 0);
  formatCols(led, LEDGER_HEADERS, LEDGER_FMTS, LEDGER_TEXT);
  widths(led, { 날짜: 92, 시각: 72, 상품명: 150, 구분: 64, 수량: 52, 단가: 72, 할인: 68, 금액: 82,
                결제방식: 76, 현금: 78, 계좌이체: 78, 고객명: 90, 연락처: 110, 비고: 200 });
  hideCol(led, LEDGER_HEADERS, '기록ID');

  var ord = makeTab(ss, ORDER_TAB, ORDER_HEADERS, 2);
  formatCols(ord, ORDER_HEADERS, ORDER_FMTS, ORDER_TEXT);
  widths(ord, { 예약번호: 64, 등록일시: 128, 성함: 90, 연락처: 110, 주문내역: 280, 수량: 52, 금액: 82,
                결제수단: 76, 입금: 60, 수령: 60, 메모: 200 });
  hideCol(ord, ORDER_HEADERS, '기록ID');
  hideCol(ord, ORDER_HEADERS, '수정순번');

  makeSummary(ss);
  sentSheet(ss);

  var s1 = ss.getSheets()[0];
  if (s1 && s1.getName() !== SUMMARY_TAB && s1.getLastRow() === 0 && ss.getSheets().length > 4) {
    try { ss.deleteSheet(s1); } catch (e) {}   // 새 스프레드시트의 빈 '시트1' 정리
  }
  ss.setActiveSheet(ss.getSheetByName(SUMMARY_TAB));
  Logger.log('완료: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
}

function makeTab(ss, name, headers, index) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name, index);
  var cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  var have = cur.map(function (v) { return String(v).trim(); }).filter(String);
  if (!have.length) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    // 이미 있으면 빠진 머리글만 오른쪽 끝에 붙인다 (있는 데이터는 그대로)
    var miss = headers.filter(function (n) { return have.indexOf(n) === -1; });
    if (miss.length) sh.getRange(1, cur.length + 1, 1, miss.length).setValues([miss]);
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#eef2f9');
  return sh;
}

function formatCols(sh, headers, fmts, textCols) {
  var h = headerMap(sh, headers);
  var rows = sh.getMaxRows() - 1;
  Object.keys(fmts).forEach(function (n) { sh.getRange(2, h.col[n], rows, 1).setNumberFormat(fmts[n]); });
  textCols.forEach(function (n) { if (h.col[n]) sh.getRange(2, h.col[n], rows, 1).setNumberFormat('@'); });
}

function widths(sh, w) {
  var h = headerMap(sh, null);
  Object.keys(w).forEach(function (n) { if (h.col[n]) sh.setColumnWidth(h.col[n], w[n]); });
}

function hideCol(sh, headers, name) {
  var h = headerMap(sh, headers);
  try { sh.hideColumns(h.col[name]); } catch (e) {}
}

/* 요약 — 수식뿐이라 앱이 쓰지 않는다. 판매기록 · 예약이 바뀌면 저절로 따라온다. */
function makeSummary(ss) {
  var sh = ss.getSheetByName(SUMMARY_TAB) || ss.insertSheet(SUMMARY_TAB, 0);
  sh.clear();
  var L = "'" + LEDGER_TAB + "'!", O = "'" + ORDER_TAB + "'!";
  var cells = [
    ['바자회 매출 요약', '', '판매기록 · 예약 탭을 읽어 자동으로 계산합니다 (손대지 마세요)'],
    ['', '', ''],
    ['순매출 (반품 차감)', '=SUM(' + L + 'H2:H)', ''],
    ['💵 현금', '=SUM(' + L + 'J2:J)', ''],
    ['💳 계좌이체', '=SUM(' + L + 'K2:K)', ''],
    ['할인 합계', '=SUM(' + L + 'G2:G)', ''],
    ['반품 금액', '=-SUMIFS(' + L + 'H2:H,' + L + 'D2:D,"반품")', ''],
    /* COUNTUNIQUE(FILTER(…)) 는 쓰지 않는다 — 판매가 0건이면 FILTER 가 #N/A 를 내는데 COUNTUNIQUE 가
       그 오류를 값 하나로 세서 1 이 된다 (2026-11-03 시험 기록을 다 지운 뒤 실제로 1 로 남았다) */
    ['판매 건수', '=COUNTUNIQUEIFS(' + L + 'O2:O,' + L + 'D2:D,"판매")', ''],
    ['판매 개수 (반품 차감)', '=SUMIFS(' + L + 'E2:E,' + L + 'D2:D,"판매")+SUMIFS(' + L + 'E2:E,' + L + 'D2:D,"반품")', ''],
    ['', '', ''],
    ['예약 건수', '=COUNTA(' + O + 'L2:L)', ''],
    ['예약 — 수령 대기', '=COUNTIF(' + O + 'J2:J,"대기")', ''],
    ['예약 — 미입금 금액', '=SUMIFS(' + O + 'G2:G,' + O + 'I2:I,"미입금",' + O + 'J2:J,"대기")', ''],
  ];
  sh.getRange(1, 1, cells.length, 3).setValues(cells);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  sh.getRange(1, 3).setFontColor('#6a7385');
  sh.getRange(3, 1, 11, 1).setFontWeight('bold');
  sh.getRange(3, 2, 11, 1).setNumberFormat('#,##0').setHorizontalAlignment('right');

  var top = 16;
  // 할인 = 그 상품 줄의 할인 합(세트 할인 포함, 반품은 빠짐) → 판매 × 단가 − 할인 = 매출 이 한 줄에서 보인다
  var head = ['상품명', '입고', '재고조정', '판매', '반품', '남은 재고', '할인', '매출'];
  sh.getRange(top - 1, 1).setValue('상품별').setFontWeight('bold');
  sh.getRange(top, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#eef2f9');
  var A = 'A' + (top + 1) + ':A';
  var sumif = function (col, kind) {
    return 'SUMIFS(' + L + col + '2:' + col + ',' + L + 'C2:C,' + A + ',' + L + 'D2:D,"' + kind + '")';
  };
  sh.getRange(top + 1, 1).setFormula('=IFERROR(SORT(UNIQUE(FILTER(' + L + 'C2:C,' + L + 'C2:C<>""))),"")');
  sh.getRange(top + 1, 2).setFormula('=ARRAYFORMULA(IF(' + A + '="",,' + sumif('E', '입고') + '))');
  sh.getRange(top + 1, 3).setFormula('=ARRAYFORMULA(IF(' + A + '="",,' + sumif('E', '재고조정') + '))');
  sh.getRange(top + 1, 4).setFormula('=ARRAYFORMULA(IF(' + A + '="",,' + sumif('E', '판매') + '))');
  sh.getRange(top + 1, 5).setFormula('=ARRAYFORMULA(IF(' + A + '="",,-' + sumif('E', '반품') + '))');
  sh.getRange(top + 1, 6).setFormula('=ARRAYFORMULA(IF(' + A + '="",,B' + (top + 1) + ':B+C' + (top + 1) +
                                     ':C-D' + (top + 1) + ':D+E' + (top + 1) + ':E))');
  sh.getRange(top + 1, 7).setFormula('=ARRAYFORMULA(IF(' + A + '="",,SUMIFS(' + L + 'G2:G,' + L + 'C2:C,' + A + ')))');
  sh.getRange(top + 1, 8).setFormula('=ARRAYFORMULA(IF(' + A + '="",,SUMIFS(' + L + 'H2:H,' + L + 'C2:C,' + A + ')))');
  sh.getRange(top + 1, 7, 200, 2).setNumberFormat('#,##0');
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(3, 90);
  sh.setFrozenRows(0);
}

function 설치_확인() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = ['이 코드의 버전: ' + MIRROR_VERSION];
  out.push('토큰: ' + (scriptToken() ? '있음' : '없음 → 토큰_만들기 를 실행하세요'));
  [[LEDGER_TAB, LEDGER_HEADERS], [ORDER_TAB, ORDER_HEADERS]].forEach(function (x) {
    var sh = ss.getSheetByName(x[0]);
    if (!sh) { out.push('✗ "' + x[0] + '" 탭 없음 → 시트_만들기 를 실행하세요'); return; }
    try { headerMap(sh, x[1]); out.push('✓ "' + x[0] + '" 머리글 정상 · ' + Math.max(sh.getLastRow() - 1, 0) + '줄'); }
    catch (e) { out.push('✗ ' + e.message); }
  });
  out.push(ss.getSheetByName(SUMMARY_TAB) ? '✓ "요약" 탭 있음' : '✗ "요약" 탭 없음 → 시트_만들기');
  out.push('손으로 적힌 줄(기록ID 없음): ' + countHandRows(ss) + '줄');
  Logger.log(out.join('\n'));
}

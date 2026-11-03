/* 구글 스프레드시트 흉내 — apps-script/Code.gs 를 Node 에서 그대로 돌려 보려고 만든 것.
   실제 시트가 하는 일 중 Code.gs 가 기대는 것만 흉내 낸다:
   - 범위가 시트 크기(처음 1000줄)를 넘으면 오류
   - 서식이 '@'(글자)가 아닌 칸에 숫자처럼 생긴 글자를 넣으면 숫자로 바꿔 버림 (전화번호 0 이 사라지는 그 일)
   - ' 로 시작하는 글자는 ' 를 떼고 글자로 둠, = 로 시작하면 수식으로 받아 #ERROR!
   - 입력 규칙(validator)에 걸리면 **그 칸 앞까지 쓴 채로** 오류 (실제 시트가 그렇게 반쪽 줄을 남겼다)
   - getDisplayValues 는 날짜·시각 서식대로 글자를 만든다 */
import vm from 'node:vm';
import fs from 'node:fs';
import { serialDateText, serialTimeText } from '../ledger.js';

class Range {
  constructor(sheet, r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`잘못된 범위 ${r},${c},${nr},${nc}`);
    if (r + nr - 1 > sheet.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  cells(fn) {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(fn(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  getValues() { return this.cells((r, c) => this.sheet.val(r, c)); }
  getValue() { return this.sheet.val(this.r, this.c); }
  getDisplayValues() { return this.cells((r, c) => this.sheet.disp(r, c)); }
  setValues(v) {
    if (v.length !== this.nr || v.some(row => row.length !== this.nc)) throw new Error('setValues 크기가 범위와 다릅니다');
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.put(this.r + i, this.c + j, v[i][j]);
    return this;
  }
  setValue(v) { this.sheet.put(this.r, this.c, v); return this; }
  setFormula(f) { this.sheet.put(this.r, this.c, f); return this; }
  clearContent() { this.cells((r, c) => this.sheet.raw(r, c, '')); return this; }
  setNumberFormat(f) { this.cells((r, c) => { this.sheet.fmt.set(`${r},${c}`, f); }); return this; }
  getMergedRanges() { return []; }
  getA1Notation() { return `R${this.r}C${this.c}`; }
  setFontWeight() { return this; } setBackground() { return this; } setFontSize() { return this; }
  setFontColor() { return this; } setHorizontalAlignment() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.fmt = new Map(); this.maxRows = 1000; this.validators = []; }
  getName() { return this.name; }
  raw(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    const row = this.rows[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }
  put(r, c, v) {
    this.validators.forEach(fn => fn(r, c, v));      // 걸리면 여기서 터진다 (앞 칸은 이미 써짐)
    const f = this.fmt.get(`${r},${c}`);
    if (typeof v === 'string') {
      if (v.startsWith("'")) v = v.slice(1);
      else if (v.startsWith('=')) v = { formula: v };
      else if (f !== '@' && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
    }
    if (v instanceof Date) v = { date: v };
    this.raw(r, c, v);
  }
  val(r, c) {
    const v = (this.rows[r - 1] || [])[c - 1];
    if (v === undefined) return '';
    if (v && v.formula) return '#ERROR!';
    if (v && v.date) return v.date;
    return v;
  }
  disp(r, c) {
    const v = this.val(r, c);
    const f = this.fmt.get(`${r},${c}`);
    if (typeof v === 'number') {
      if (f === 'yyyy-mm-dd') return serialDateText(v);
      if (f === 'HH:mm:ss') return serialTimeText(v);
      if (f === 'yyyy-mm-dd HH:mm') return `${serialDateText(v)} ${serialTimeText(v).slice(0, 5)}`;
    }
    return v instanceof Date ? v.toISOString() : String(v);
  }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i].some(v => v !== '' && v !== undefined)) return i + 1;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.rows.forEach(row => row.forEach((v, j) => { if (v !== '' && v !== undefined) m = Math.max(m, j + 1); }));
    return m;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  deleteRow(r) { this.rows.splice(r - 1, 1); this.maxRows--; }
  hideColumns() {} hideSheet() {} setFrozenRows() {} setColumnWidth() {}
  clear() { this.rows = []; }
  /* 시험용: 지금 줄들을 머리글 이름 붙인 객체로 */
  records() {
    const head = (this.rows[0] || []).map(String);
    return this.rows.slice(1).filter(r => r.some(v => v !== '')).map(r => {
      const o = {};
      head.forEach((h, i) => { if (h) o[h] = r[i] === undefined ? '' : r[i]; });
      return o;
    });
  }
}

class Spreadsheet {
  constructor() { this.sheets = [new Sheet('시트1')]; this.name = '시험용 바자회 시트'; }
  getName() { return this.name; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  getSheets() { return [...this.sheets]; }
  insertSheet(name, index) {
    const s = new Sheet(name);
    if (index === undefined || index > this.sheets.length) this.sheets.push(s);
    else this.sheets.splice(index, 0, s);
    return s;
  }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  setActiveSheet() {} setSpreadsheetTimeZone(tz) { this.tz = tz; }
}

/* Code.gs 를 새 시트와 함께 불러온다 */
export function loadScript() {
  const ss = new Spreadsheet();
  const props = new Map();
  const logs = [];
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    Utilities: { getUuid: () => '1234abcd-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0') },
    ContentService: { createTextOutput: s => ({ setMimeType() { return { body: s }; } }), MimeType: { JSON: 'json' } },
    Logger: { log: m => logs.push(String(m)) },
    console,
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  vm.runInContext(src, ctx, { filename: 'Code.gs' });
  const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).body);
  return { ss, ctx, props, logs, post };
}

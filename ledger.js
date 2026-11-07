/* ─────────────────────────────────────────────────────────────
   바자회 POS — 시트로 가는 줄을 만드는 곳 (순수 함수만 둔다)

   앱(index.html)과 시험(tests/*.mjs)이 **같은 이 파일**을 불러 쓴다.
   그래서 시험이 통과하면 앱이 실제로 보내는 줄도 같은 규칙을 지킨다.

   시트 '판매기록' 한 줄 = 상품 하나. 모든 줄이 언제나 이 식을 만족한다:
     금액 = 단가 × 수량 − 할인
     현금 + 계좌이체 = 금액
     (거래 하나의 줄들) 금액 합 = 그 거래에서 실제로 받은(돌려준) 돈
   반품은 수량 · 할인 · 금액 · 현금 · 계좌이체가 음수다. 그래서 열을 그냥 SUM 하면
   반품까지 뺀 진짜 합계가 나온다.

   돈은 언제나 정수(원)로 나눈다 — 할인·분할결제를 품목에 나눌 때
   '가장 큰 나머지' 방식으로 나눠서 합이 1원도 어긋나지 않고, 어떤 줄도 음수가 되거나
   제 정가를 넘지 않는다.
   ───────────────────────────────────────────────────────────── */

/* Apps Script(apps-script/Code.gs)의 MIRROR_VERSION 과 같아야 한다.
   Code.gs 를 고치면 둘을 같이 올린다 — 앱이 다르면 '시트 스크립트를 새로 배포하세요' 라고 알린다. */
export const MIRROR_VERSION = '2026-11-08a';

export const LEDGER_TAB = '판매기록';
export const ORDER_TAB = '예약';
export const LEDGER_HEADERS = ['날짜', '시각', '상품명', '구분', '수량', '단가', '할인', '금액',
                               '결제방식', '현금', '계좌이체', '고객명', '연락처', '비고', '기록ID'];
export const ORDER_HEADERS = ['예약번호', '등록일시', '성함', '연락처', '주문내역', '수량', '금액',
                              '결제수단', '입금', '수령', '메모', '기록ID', '수정순번'];

/* 대조할 때 쓰는 칸들 (기록ID 는 묶는 열쇠라 따로 본다) */
export const LEDGER_NUM = ['수량', '단가', '할인', '금액', '현금', '계좌이체'];
export const LEDGER_TEXT = ['상품명', '구분', '결제방식', '고객명', '연락처', '비고'];
export const ORDER_NUM = ['예약번호', '수량', '금액'];
export const ORDER_TEXT = ['성함', '연락처', '주문내역', '결제수단', '입금', '수령', '메모'];

export const KIND = { SALE: '판매', RETURN: '반품', IN: '입고', ADJ: '재고조정' };
export const PAY = ['현금', '계좌이체', '분할'];

const sum = a => a.reduce((s, x) => s + x, 0);
const isInt = n => Number.isInteger(n);

/* ---------- 정수 나누기 ----------
   total 원을 weights 비율대로 정수로 나눈다. 결과의 합은 언제나 정확히 total 이다.
   각 몫은 ceil(total × w / W) 를 넘지 않는다 → total ≤ W 이면 어떤 몫도 제 무게를 넘지 않는다.
   나눗셈은 전부 정수 연산이라 부동소수 오차가 끼지 않는다. */
export function allocate(total, weights) {
  if (!isInt(total)) throw new Error(`나눌 금액이 정수가 아닙니다: ${total}`);
  const n = weights.length;
  if (!n) {
    if (total) throw new Error('금액을 나눌 품목이 없습니다.');
    return [];
  }
  const w = weights.map(x => {
    if (!isInt(x) || x < 0) throw new Error(`나눌 기준이 0 이상의 정수가 아닙니다: ${x}`);
    return x;
  });
  const sign = total < 0 ? -1 : 1;
  const T = Math.abs(total);
  const W = sum(w);
  const out = new Array(n).fill(0);
  if (T === 0) return out;
  if (W === 0) { out[n - 1] = total; return out; }
  const rem = new Array(n);
  let given = 0;
  for (let i = 0; i < n; i++) {
    const p = T * w[i];
    if (!Number.isSafeInteger(p)) throw new Error('금액이 너무 큽니다.');
    out[i] = Math.floor(p / W);
    rem[i] = p % W;
    given += out[i];
  }
  const order = rem.map((r, i) => i).sort((a, b) => rem[b] - rem[a] || a - b);
  for (let k = 0; k < T - given; k++) out[order[k]]++;
  return out.map(x => (x === 0 ? 0 : sign * x));
}

/* ---------- 날짜 · 시각 ----------
   시트에는 글자가 아니라 **날짜 일련번호**(1899-12-30 부터 센 날수)로 보낸다.
   스크립트·시트의 시간대 설정과 상관없이 같은 날짜로 찍힌다.
   (글자 '2026-11-08' 을 보내면 시트가 그 글자를 어떻게 읽을지에 따라 하루가 밀릴 수 있다) */
const EPOCH = Date.UTC(1899, 11, 30);
export function serialDate(d) {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / 86400000);
}
export function serialTime(d) {
  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
}
const p2 = n => String(n).padStart(2, '0');
/* 시트가 화면에 보여 주는 글자와 똑같이 만든다 (대조할 때 이 글자끼리 비교한다) */
export function serialDateText(s) {
  const d = new Date(EPOCH + Math.floor(s) * 86400000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
export function serialTimeText(f) {
  const secs = Math.round((f - Math.floor(f)) * 86400) % 86400;
  return `${p2(Math.floor(secs / 3600))}:${p2(Math.floor(secs / 60) % 60)}:${p2(secs % 60)}`;
}

const blank0 = v => (v === 0 ? '' : v);       // 0원은 칸을 비운다 (합계는 같고 눈에 덜 걸린다)
/* 앞의 작은따옴표는 시트가 '글자로 두라' 는 표시로 먹어 버리므로 처음부터 떼어 둔다 */
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/^'+\s*/, '');

/* ---------- 거래 → 줄 ----------
   t: 앱의 거래 문서
     type      'sale' | 'return'
     time      ISO 문자열
     items     [{ title, qty(양수), price }]
     received  받은 돈 (반품이면 돌려준 돈의 음수)
     method    '현금' | '계좌이체' | '분할'
     split     분할이면 { cash, transfer } (반품이면 둘 다 음수)
     setLabel  세트로 판 거래면 "2개 세트 · 6개 세트" — 할인이 0원이어도 비고에 남는다
     discountLabel  할인 칸(손으로 넣은 할인)의 사유 · note · customer · phone */
/* ---------- 세트 → 시트 줄 나누기 ----------
   t.sets = [{ size, disc, picks: [{ bookId, title?, qty }] }] — 판매면 판 세트, 반품이면 돌려받은 세트.
   세트가 있는 거래는 한 상품이라도 '세트에 든 몫' 과 '낱개 몫' 을 다른 줄로 나눈다
   (같은 상품이 2개 세트 · 6개 세트에 다 들어 있으면 세트 크기마다 한 줄). 비고 "2개 세트" 는 그 세트 줄에만 붙는다.
   세트 하나의 할인(disc)은 그 세트에 든 맛들에만, 맛 정가 비율로 나눈다.
   세트가 없는 거래(예전 거래 포함)는 지금까지처럼 상품마다 한 줄. */
const pickIdx = (items, x) => items.findIndex(i => (x.bookId && i.bookId) ? i.bookId === x.bookId : clean(i.title) === clean(x.title));
export function txLines(t) {
  const items = (t.items || []).filter(i => i && i.qty);
  const sets = (t.sets || []).filter(Boolean);
  if (!sets.length) return items.map((i, k) => ({ k, label: null, qty: i.qty, gross: i.price * i.qty, setDisc: 0 }));
  const groups = items.map(() => new Map());            // 상품마다: 세트 크기 → { qty, setDisc }
  const used = items.map(() => 0);
  sets.forEach(st => {
    const picks = (st.picks || []).filter(x => x && x.qty);
    const idx = picks.map(x => pickIdx(items, x));
    if (!picks.length || idx.some(k => k < 0)) throw new Error('세트에 든 상품을 거래 품목에서 찾지 못했습니다.');
    const d = st.disc || 0;
    if (!isInt(d) || d < 0) throw new Error(`세트 할인이 올바르지 않습니다: ${d}`);
    const w = picks.map((x, j) => items[idx[j]].price * x.qty);
    if (d > sum(w)) throw new Error(`세트 할인(${d})이 세트 정가(${sum(w)})보다 큽니다.`);
    const share = allocate(d, w);
    const label = `${st.size || sum(picks.map(x => x.qty))}개 세트`;
    picks.forEach((x, j) => {
      const g = groups[idx[j]];
      const cur = g.get(label) || { qty: 0, setDisc: 0 };
      cur.qty += x.qty; cur.setDisc += share[j];
      g.set(label, cur);
      used[idx[j]] += x.qty;
    });
  });
  const out = [];
  items.forEach((i, k) => {
    if (used[k] > i.qty) throw new Error(`세트에 든 수량이 품목 수량보다 많습니다: ${clean(i.title)}`);
    groups[k].forEach((v, label) => out.push({ k, label, qty: v.qty, gross: i.price * v.qty, setDisc: v.setDisc }));
    if (i.qty - used[k] > 0) out.push({ k, label: null, qty: i.qty - used[k], gross: i.price * (i.qty - used[k]), setDisc: 0 });
  });
  return out;
}
/* 품목(상품)별로 다시 모은 것 — 화면(반품 한도 등)이 쓴다 */
export function txSetSplit(t) {
  const items = (t.items || []).filter(i => i && i.qty);
  const gross = items.map(i => i.price * i.qty);
  const setDisc = items.map(() => 0);
  txLines(t).forEach(l => { setDisc[l.k] += l.setDisc; });
  return { gross, setDisc, after: gross.map((g, k) => g - setDisc[k]) };
}

export function txRecords(t) {
  const isReturn = t.type === 'return';
  const sgn = isReturn ? -1 : 1;
  const d = new Date(t.time);
  if (isNaN(d)) throw new Error('거래 시각이 올바르지 않습니다.');
  const items = (t.items || []).filter(i => i && i.qty);
  if (!items.length) throw new Error('거래에 품목이 없습니다.');
  items.forEach(i => {
    if (!isInt(i.qty) || i.qty <= 0) throw new Error(`수량이 올바르지 않습니다: ${i.title} ${i.qty}`);
    if (!isInt(i.price) || i.price < 0) throw new Error(`단가가 올바르지 않습니다: ${i.title} ${i.price}`);
    if (!clean(i.title)) throw new Error('상품명이 비어 있습니다.');
  });
  const G = sum(items.map(i => i.price * i.qty));
  const paid = sgn * t.received;                      // 언제나 0 이상
  if (!isInt(paid) || paid < 0) throw new Error(`받은 금액이 올바르지 않습니다: ${t.received}`);
  if (paid > G) throw new Error(`받은 금액(${paid})이 정가 합계(${G})보다 큽니다.`);
  // 세트 할인은 그 세트 줄에만 먼저 빼고, 나머지 할인(할인 칸)은 세트 반영 후 금액에 비례해서 나눈다
  const lines = txLines({ ...t, items });
  const gross = lines.map(l => l.gross);
  const after = lines.map(l => l.gross - l.setDisc);
  const A = sum(after);
  if (paid > A) throw new Error(`받은 금액(${paid})이 세트 값을 반영한 합계(${A})보다 큽니다.`);
  const nets = allocate(paid, after);

  let cash, transfer;
  if (t.method === '현금') { cash = nets; transfer = nets.map(() => 0); }
  else if (t.method === '계좌이체') { transfer = nets; cash = nets.map(() => 0); }
  else if (t.method === '분할') {
    const sc = sgn * ((t.split && t.split.cash) || 0), st = sgn * ((t.split && t.split.transfer) || 0);
    if (!isInt(sc) || !isInt(st) || sc < 0 || st < 0 || sc + st !== paid) {
      throw new Error(`분할 금액이 맞지 않습니다: 현금 ${sc} + 계좌이체 ${st} ≠ ${paid}`);
    }
    cash = allocate(sc, nets);
    transfer = nets.map((n, i) => n - cash[i]);
  } else {
    throw new Error(`결제방식이 올바르지 않습니다: ${t.method}`);
  }

  const hasSets = (t.sets || []).some(Boolean);
  const memoOf = l => {
    const m = [];
    if (hasSets) {
      if (l.label) m.push(l.label);                                   // 세트 줄에만
      if (!isReturn && (t.discount || 0) > 0 && clean(t.discountLabel)) m.push(clean(t.discountLabel));
    } else {                                                          // 예전 방식 그대로 (시트 대조가 옛 줄과 맞게)
      if (!isReturn && clean(t.setLabel)) m.push(clean(t.setLabel));
      if (!isReturn && (t.discount || 0) > 0 && (clean(t.discountLabel) || !clean(t.setLabel))) m.push(clean(t.discountLabel) || '할인');
    }
    if (t.note) m.push(clean(t.note));
    return m.join(' · ');
  };
  const base = {
    날짜: serialDate(d), 시각: serialTime(d),
    구분: isReturn ? KIND.RETURN : KIND.SALE,
    결제방식: t.method,
    고객명: clean(t.customer), 연락처: clean(t.phone),
  };
  return lines.map((l, j) => ({
    ...base,
    상품명: clean(items[l.k].title),
    수량: sgn * l.qty,
    단가: items[l.k].price,
    할인: blank0(sgn * (gross[j] - nets[j])),
    금액: sgn * nets[j],
    현금: blank0(sgn * cash[j]),
    계좌이체: blank0(sgn * transfer[j]),
    비고: memoOf(l),
  })).map(r => ({ ...r, 수량: r.수량 || 0, 금액: r.금액 || 0 }));
}

/* 입고 · 재고조정 한 줄. 돈 칸은 비운다 (바자회 상품은 사 온 게 아니라 만든 것이다).
   입고는 수량 양수, 재고조정은 늘면 양수 · 줄면 음수. */
export function stockRecord({ title, qty, kind, note, time }) {
  if (kind !== KIND.IN && kind !== KIND.ADJ) throw new Error(`재고 구분이 올바르지 않습니다: ${kind}`);
  if (!isInt(qty) || qty === 0) throw new Error(`재고 수량이 올바르지 않습니다: ${qty}`);
  if (kind === KIND.IN && qty < 0) throw new Error('입고 수량은 양수여야 합니다.');
  const d = new Date(time);
  return {
    날짜: serialDate(d), 시각: serialTime(d),
    상품명: clean(title), 구분: kind, 수량: qty,
    단가: '', 할인: '', 금액: '', 결제방식: '', 현금: '', 계좌이체: '',
    고객명: '', 연락처: '', 비고: clean(note),
  };
}

/* ---------- 예약 → '예약' 탭 한 줄 ---------- */
/* 세트 예약: o.sets = [{ size, disc, n }], o.discount = 세트 할인 합, o.discountLabel = "2개 세트 · 3개 세트 ×2".
   금액은 정가 합 − 할인. 주문내역 끝에 세트 표시가 붙어 시트에서도 왜 싼지 보인다. */
const comma = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const orderGross = o => sum((o.items || []).map(i => (i.price || 0) * (i.qty || 0)));
export const orderDisc = o => Math.min(Math.max(o.discount || 0, 0), orderGross(o));
export const orderDesc = o => (o.items || []).map(i => `${clean(i.title)} ${i.qty}`).join(', ')
  + ((orderDisc(o) > 0 || (o.sets || []).length) ? ` · ${clean(o.discountLabel) || '할인'}${orderDisc(o) > 0 ? ` −${comma(orderDisc(o))}원` : ''}` : '');
export const orderQty = o => sum((o.items || []).map(i => i.qty || 0));
export const orderAmt = o => orderGross(o) - orderDisc(o);
export function orderRecord(o) {
  const d = new Date(o.time);
  return {
    예약번호: o.no || 0,
    등록일시: serialDate(d) + serialTime(d),
    성함: clean(o.name), 연락처: clean(o.phone),
    주문내역: orderDesc(o), 수량: orderQty(o), 금액: orderAmt(o),
    결제수단: o.method || '계좌이체',
    입금: o.paid ? '입금' : '미입금',
    수령: o.handed ? '수령' : '대기',
    메모: clean(o.note),
  };
}

/* ---------- 스스로 점검 ----------
   만든 줄이 위의 식을 정말 지키는지 다시 센다. 하나라도 어긋나면 결제를 막는다 —
   틀린 줄을 시트에 보내느니 그 자리에서 멈추는 편이 낫다. 빈 배열이면 이상 없음. */
const num = v => (v === '' || v == null ? 0 : Number(v));
export function checkTxRecords(t, recs) {
  const errs = [];
  const sgn = t.type === 'return' ? -1 : 1;
  recs.forEach((r, k) => {
    if (num(r.금액) !== num(r.단가) * num(r.수량) - num(r.할인)) errs.push(`${k + 1}번째 줄: 금액 ≠ 단가×수량−할인`);
    if (num(r.현금) + num(r.계좌이체) !== num(r.금액)) errs.push(`${k + 1}번째 줄: 현금+계좌이체 ≠ 금액`);
    if (sgn * num(r.금액) < 0 || sgn * num(r.현금) < 0 || sgn * num(r.계좌이체) < 0) errs.push(`${k + 1}번째 줄: 부호가 거꾸로`);
    if (sgn * num(r.할인) < 0) errs.push(`${k + 1}번째 줄: 할인이 음수`);
  });
  const total = sum(recs.map(r => num(r.금액)));
  if (total !== t.received) errs.push(`금액 합 ${total} ≠ 받은 금액 ${t.received}`);
  const items = (t.items || []).filter(i => i && i.qty);
  if (sum(recs.map(r => num(r.수량))) !== sgn * sum(items.map(i => i.qty))) errs.push('수량 합이 다릅니다');
  if (t.method === '분할') {
    if (sum(recs.map(r => num(r.현금))) !== t.split.cash) errs.push('현금 합이 다릅니다');
    if (sum(recs.map(r => num(r.계좌이체))) !== t.split.transfer) errs.push('계좌이체 합이 다릅니다');
  }
  return errs;
}

/* ---------- 앱 ↔ 시트 대조 ----------
   expected: Map(기록ID → 앱이 보냈어야 할 줄 배열)
   sheet:    [{ key, rec }]  — 시트에서 읽은 줄 (날짜·시각은 화면 글자, 나머지는 값)
   돌려주는 것: { missing: [키], extra: [키], diff: [{ key, why }] } — 셋 다 비면 완전히 같다. */
/* 시트가 '=' 등으로 시작하는 글자를 지키려고 붙인 앞 작은따옴표는 떼고 본다 */
const unq = v => String(v ?? '').replace(/^'/, '');
function normLedger(r, fromSheet) {
  const o = {};
  o.날짜 = fromSheet ? String(r.날짜 ?? '').trim() : serialDateText(r.날짜);
  o.시각 = fromSheet ? String(r.시각 ?? '').trim() : serialTimeText(r.시각);
  LEDGER_NUM.forEach(f => { o[f] = num(r[f]); });
  LEDGER_TEXT.forEach(f => { o[f] = clean(fromSheet ? unq(r[f]) : r[f]); });
  return o;
}
function normOrder(r, fromSheet) {
  const o = {};
  if (fromSheet) o.등록일시 = String(r.등록일시 ?? '').trim();
  else o.등록일시 = `${serialDateText(r.등록일시)} ${serialTimeText(r.등록일시).slice(0, 5)}`;
  ORDER_NUM.forEach(f => { o[f] = num(r[f]); });
  ORDER_TEXT.forEach(f => { o[f] = clean(fromSheet ? unq(r[f]) : r[f]); });
  return o;
}
function sameRow(a, b) {
  const bad = Object.keys(a).filter(k => a[k] !== b[k]);
  return bad.length ? bad.map(k => `${k}: 앱 ${JSON.stringify(a[k])} / 시트 ${JSON.stringify(b[k])}`).join(', ') : '';
}
function compareKeyed(expected, sheet, norm) {
  const got = new Map();
  sheet.forEach(({ key, rec }) => {
    if (!key) return;
    if (!got.has(key)) got.set(key, []);
    got.get(key).push(rec);
  });
  const missing = [], extra = [], diff = [];
  expected.forEach((recs, key) => {
    const have = got.get(key);
    if (!have) { missing.push(key); return; }
    if (have.length !== recs.length) { diff.push({ key, why: `줄 수: 앱 ${recs.length} / 시트 ${have.length}` }); return; }
    for (let i = 0; i < recs.length; i++) {
      const why = sameRow(norm(recs[i], false), norm(have[i], true));
      if (why) { diff.push({ key, why: `${i + 1}번째 줄 — ${why}` }); return; }
    }
  });
  got.forEach((_, key) => { if (!expected.has(key)) extra.push(key); });
  return { missing, extra, diff };
}
export const compareLedger = (expected, sheet) => compareKeyed(expected, sheet, normLedger);
export const compareOrders = (expected, sheet) => compareKeyed(expected, sheet, normOrder);

/* ---------- 앱 기록 → '시트에 있어야 할 것' ----------
   대조(verify)와 고치기가 쓰는 정답표. 앱 화면과 같은 데이터에서 만든다.
     transactions  판매 · 반품 거래
     stockLogs     재고 원장. 시트로 간 줄은 { sheetKey, sheetRec, bookId } 를 들고 있다.
                   나중에 무른 줄은 { voidKey } 를 든 줄이 따로 남는다 (원장은 고쳐 쓰지 않는다).
     products      지금 상품 목록 — 지운 상품의 입고 줄은 시트에서도 지웠으므로 뺀다.
                   이름을 바꾼 상품은 지금 이름으로 본다 (시트도 rename 으로 바꿨다). */
export const txKey = t => 'tx:' + t.id;
export const orderKey = o => 'order:' + o.id;

export function expectedLedger({ transactions = [], stockLogs = [], products = [] }) {
  const exp = new Map();
  transactions.forEach(t => exp.set(txKey(t), txRecords(t)));
  const byId = new Map(products.map(p => [p.id, p]));
  const voided = new Set(stockLogs.filter(l => l.voidKey).map(l => l.voidKey));
  [...stockLogs]
    .filter(l => l.sheetKey && l.sheetRec && !voided.has(l.sheetKey))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .forEach(l => {
      const p = byId.get(l.bookId);
      if (!p) return;
      exp.set(l.sheetKey, [{ ...l.sheetRec, 상품명: clean(p.name) }]);
    });
  return exp;
}
export function expectedOrders(preorders = []) {
  const exp = new Map();
  preorders.forEach(o => exp.set(orderKey(o), [orderRecord(o)]));
  return exp;
}

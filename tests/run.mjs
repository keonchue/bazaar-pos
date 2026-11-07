/* 바자회 POS 시험 — `node tests/run.mjs`
   1) ledger.js 의 돈 나누기 · 줄 만들기를 무작위 거래 수천 개로 두드린다
   2) apps-script/Code.gs 를 흉내 낸 시트(mock-sheets.mjs)에서 그대로 돌려,
      보낸 줄이 한 칸도 다르지 않게 적히는지 · 다시 보내도 안 겹치는지 · 지우기/고치기/예약/거절이
      맞게 되는지 · 대조가 조작을 찾아내는지를 본다. */
import assert from 'node:assert/strict';
import {
  allocate, txRecords, stockRecord, checkTxRecords, orderRecord, compareLedger, compareOrders,
  expectedLedger, expectedOrders, MIRROR_VERSION, LEDGER_HEADERS, ORDER_HEADERS, KIND, txKey, orderKey,
} from '../ledger.js';
import { loadScript } from './mock-sheets.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
};
const sum = a => a.reduce((s, x) => s + x, 0);
const n0 = v => (v === '' || v == null ? 0 : Number(v));
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));

/* 무작위 거래 하나 — 앱의 checkout 과 같은 모양 */
const NAMES = ['딸기 요거트', '딸기 녹차초코', '바나나 다크초코', '바나나 녹차초코', '귤 요거트', '귤 화이트초코', '녹차 음료'];
function randomSale(i) {
  const k = ri(1, 4);
  const pick = [...NAMES].sort(() => rnd() - 0.5).slice(0, k);
  const items = pick.map(title => ({ title, qty: ri(1, 5), price: [0, 1000, 2500, 3000, 3500, 4000, 5000, 1700][ri(0, 7)] }));
  const total = sum(items.map(i => i.qty * i.price));
  const discount = rnd() < 0.4 ? Math.min(total, ri(0, 3) === 0 ? total : ri(0, Math.max(1, Math.floor(total / 2)))) : 0;
  const payable = total - discount;
  const r = rnd();
  let method = r < 0.45 ? '현금' : r < 0.85 ? '계좌이체' : '분할';
  let split = null;
  if (method === '분할') {
    if (payable < 2) method = '현금';
    else { const c = ri(1, payable - 1); split = { cash: c, transfer: payable - c }; }
  }
  return {
    id: 'S' + i, type: 'sale', time: new Date(2026, 10, 8, ri(9, 17), ri(0, 59), ri(0, 59)).toISOString(),
    items, qty: sum(items.map(i => i.qty)), total, discount, received: payable, method, split,
    discountLabel: discount ? ['', '직원할인', '=SUM(1)'][ri(0, 2)] : null,
    customer: ['', '홍길동', '+82 10 1234', '01012345678', '=HYPERLINK("x")', "'따옴표"][ri(0, 5)],
    phone: ['', '010-1234-5678', '01098765432'][ri(0, 2)],
    note: rnd() < 0.2 ? `예약 수령 #${ri(1, 30)}` : '',
  };
}
/* 판매 하나에서 일부를 반품 — 환불액은 그 몫의 실제 받은 돈 (앱의 반품 창 기본값과 같은 셈) */
function randomReturn(sale, i) {
  const recs = txRecords(sale);
  const picks = sale.items.map((it, k) => ({ it, k, q: ri(0, it.qty) })).filter(x => x.q);
  if (!picks.length) picks.push({ it: sale.items[0], k: 0, q: 1 });
  const items = picks.map(x => ({ title: x.it.title, qty: x.q, price: x.it.price }));
  const refund = sum(picks.map(x => Math.floor(recs[x.k].금액 * x.q / x.it.qty)));
  let method = sale.method, split = null;
  if (method === '분할') {
    const c = Math.floor(refund * sale.split.cash / sale.received || 0);
    split = { cash: -c, transfer: -(refund - c) };
  }
  return { id: 'R' + i, type: 'return', refId: sale.id, time: new Date(2026, 10, 8, 18, ri(0, 59)).toISOString(),
           items, qty: -sum(items.map(i => i.qty)), received: -refund, method, split, customer: sale.customer };
}

console.log('\n[1] 돈 나누기 (allocate)');
test('합이 언제나 정확하고, 어떤 몫도 제 무게를 넘지 않는다 (무작위 20,000번)', () => {
  for (let n = 0; n < 20000; n++) {
    const w = Array.from({ length: ri(1, 6) }, () => ri(0, 30000));
    const W = sum(w);
    const total = ri(0, W);
    const out = allocate(total, w);
    assert.equal(sum(out), total);
    out.forEach((x, i) => { assert.ok(Number.isInteger(x) && x >= 0 && x <= w[i] + (W === 0 ? total : 0), `${x} > ${w[i]}`); });
    const neg = allocate(-total, w);
    assert.equal(sum(neg), -total);
  }
});
test('정수가 아닌 금액은 거절한다', () => { assert.throws(() => allocate(10.5, [1, 2])); });

console.log('\n[2] 거래 → 시트 줄 (txRecords)');
const SALES = Array.from({ length: 3000 }, (_, i) => randomSale(i));
test('판매 3,000건: 모든 줄이 금액 = 단가×수량−할인, 현금+계좌이체 = 금액, 합 = 받은 돈', () => {
  SALES.forEach(t => {
    const recs = txRecords(t);
    assert.deepEqual(checkTxRecords(t, recs), [], JSON.stringify(t));
    assert.equal(recs.length, t.items.length);
    const cash = sum(recs.map(r => n0(r.현금))), tr = sum(recs.map(r => n0(r.계좌이체)));
    if (t.method === '현금') { assert.equal(cash, t.received); assert.equal(tr, 0); }
    if (t.method === '계좌이체') { assert.equal(tr, t.received); assert.equal(cash, 0); }
    if (t.method === '분할') { assert.equal(cash, t.split.cash); assert.equal(tr, t.split.transfer); }
    assert.equal(sum(recs.map(r => n0(r.할인))), t.discount);
    recs.forEach(r => { assert.ok(n0(r.금액) >= 0 && n0(r.할인) >= 0 && n0(r.현금) >= 0 && n0(r.계좌이체) >= 0); });
  });
});
const RETURNS = SALES.filter((_, i) => i % 5 === 0).map((s, i) => randomReturn(s, i));
test('반품 600건: 음수로 정확히 되돌리고 같은 식을 지킨다', () => {
  RETURNS.forEach(t => {
    const recs = txRecords(t);
    assert.deepEqual(checkTxRecords(t, recs), [], JSON.stringify(t));
    recs.forEach(r => { assert.ok(r.수량 < 0 && n0(r.금액) <= 0 && n0(r.할인) <= 0 && r.구분 === '반품'); });
  });
});
test('잘못된 거래는 줄을 만들지 않고 멈춘다', () => {
  const base = { id: 'x', type: 'sale', time: new Date().toISOString(), items: [{ title: 'A', qty: 1, price: 1000 }], received: 1000, method: '현금' };
  assert.throws(() => txRecords({ ...base, received: 1500 }));                   // 정가보다 많이 받음
  assert.throws(() => txRecords({ ...base, method: '카드' }));                   // 없는 결제방식
  assert.throws(() => txRecords({ ...base, method: '분할', split: { cash: 300, transfer: 600 } }));  // 합이 다름
  assert.throws(() => txRecords({ ...base, items: [{ title: 'A', qty: 1.5, price: 1000 }] }));
  assert.throws(() => txRecords({ ...base, time: 'nope' }));
});
test('날짜·시각은 기기 시각 그대로 (2026-11-08 14:05:09)', () => {
  const t = { id: 'd', type: 'sale', time: new Date(2026, 10, 8, 14, 5, 9).toISOString(),
              items: [{ title: 'A', qty: 1, price: 3000 }], received: 3000, method: '현금' };
  const [r] = txRecords(t);
  assert.equal(r.날짜, 46334);                                   // 2026-11-08 의 시트 일련번호
  assert.equal(Math.round(r.시각 * 86400), 14 * 3600 + 5 * 60 + 9);
});

console.log('\n[3] Code.gs 를 시트 흉내에 돌려 보기');
const S = loadScript();
const TOKEN = 'test-token';
S.props.set('MIRROR_TOKEN', TOKEN);
S.ctx.시트_만들기();
const ledger = () => S.ss.getSheetByName('판매기록');
const orders = () => S.ss.getSheetByName('예약');
const send = ops => S.post({ token: TOKEN, action: 'ops', ops });
const verify = () => S.post({ token: TOKEN, action: 'verify' });
const rowsOp = t => ({ key: txKey(t), op: 'rows', records: txRecords(t) });

test('시트_만들기: 탭 · 머리글이 앱과 같다', () => {
  assert.deepEqual(ledger().rows[0].slice(0, LEDGER_HEADERS.length), LEDGER_HEADERS);
  assert.deepEqual(orders().rows[0].slice(0, ORDER_HEADERS.length), ORDER_HEADERS);
  assert.ok(S.ss.getSheetByName('요약'));
  assert.equal(S.ss.tz, 'Asia/Seoul');
});
test('요약 수식에 0건일 때 1 이 되는 COUNTUNIQUE(FILTER(…)) 가 없다', () => {
  const sum = S.ss.getSheetByName('요약');
  const formulas = sum.rows.flat().filter(v => v && v.formula).map(v => v.formula);
  assert.ok(formulas.length > 5);
  assert.ok(!formulas.some(f => /COUNTUNIQUE\(\s*(IFERROR\()?FILTER/i.test(f)), formulas.join(' / '));
  assert.ok(formulas.some(f => /COUNTUNIQUEIFS\(/.test(f)));
});
test('토큰이 틀리면 아무것도 안 적는다', () => {
  const out = S.post({ token: 'wrong', action: 'ops', ops: [rowsOp(SALES[0])] });
  assert.equal(out.ok, false);
  assert.equal(ledger().getLastRow(), 1);
});
test('버전이 앱과 같다', () => { assert.equal(S.post({ token: TOKEN, action: 'ping' }).version, MIRROR_VERSION); });

// 실제처럼: 입고 → 판매 1,200건 (40건씩 묶음) → 일부 반품
const products = NAMES.map((name, i) => ({ id: 'P' + i, name }));
const stockLogs = products.map((p, i) => ({
  bookId: p.id, time: new Date(2026, 10, 8, 8, 0, i).toISOString(),
  sheetKey: 'stock:L' + i, sheetRec: stockRecord({ title: p.name, qty: 12, kind: KIND.IN, note: '예상 수량', time: new Date(2026, 10, 8, 8, 0, i).toISOString() }),
}));
const txs = [...SALES.slice(0, 1200), ...RETURNS.slice(0, 200)];

test('판매 1,200건 + 반품 200건 + 입고 7줄을 40건씩 보내면 전부 ok', () => {
  const ops = [...stockLogs.map(l => ({ key: l.sheetKey, op: 'rows', records: [l.sheetRec] })), ...txs.map(rowsOp)];
  for (let i = 0; i < ops.length; i += 40) {
    const out = send(ops.slice(i, i + 40));
    assert.equal(out.ok, true, out.error);
    out.results.forEach(r => assert.equal(r.ok, true, r.key + ' ' + r.error));
  }
  assert.ok(ledger().getMaxRows() > 1000, '1000줄을 넘어서도 시트를 늘려서 적는다');
});
test('대조: 시트가 앱 기록과 한 칸도 다르지 않다', () => {
  const v = verify();
  const exp = expectedLedger({ transactions: txs, stockLogs, products });
  const cmp = compareLedger(exp, v.ledger);
  assert.deepEqual(cmp, { missing: [], extra: [], diff: [] });
  assert.equal(v.handRows, 0);
});
test('시트 열 합계 = 앱 합계 (현금 · 계좌이체 · 순매출 · 할인)', () => {
  const recs = ledger().records();
  const got = f => sum(recs.map(r => n0(r[f])));
  const parts = txs.flatMap(t => t.method === '분할' ? [['현금', t.split.cash], ['계좌이체', t.split.transfer]] : [[t.method, t.received]]);
  assert.equal(got('금액'), sum(txs.map(t => t.received)));
  assert.equal(got('현금'), sum(parts.filter(p => p[0] === '현금').map(p => p[1])));
  assert.equal(got('계좌이체'), sum(parts.filter(p => p[0] === '계좌이체').map(p => p[1])));
  assert.equal(got('할인') , sum(txs.map(t => txRecords(t).reduce((s, r) => s + n0(r.할인), 0))));
});
test('전화번호 0 · + · = 로 시작하는 이름이 글자 그대로 남는다', () => {
  const recs = ledger().records();
  assert.ok(recs.some(r => r.고객명 === '01012345678'));
  assert.ok(recs.some(r => r.고객명 === '+82 10 1234'));
  assert.ok(recs.some(r => r.고객명 === '=HYPERLINK("x")'));
  assert.ok(!recs.some(r => String(r.고객명).startsWith('#ERROR')));
});
test('같은 묶음을 다시 보내도 한 줄도 안 늘어난다', () => {
  const before = ledger().getLastRow();
  const out = send(txs.slice(0, 40).map(rowsOp));
  assert.ok(out.results.every(r => r.ok && r.skipped));
  assert.equal(ledger().getLastRow(), before);
});
test('지우기: 그 거래 줄만 사라지고, 늦게 온 원래 줄은 되살아나지 않는다', () => {
  const t = txs[5];
  const before = ledger().getLastRow();
  send([{ key: 'del:' + txKey(t), op: 'delete', target: txKey(t) }]);
  assert.equal(ledger().getLastRow(), before - t.items.length);
  send([rowsOp(t)]);
  assert.equal(ledger().getLastRow(), before - t.items.length);
  const exp = expectedLedger({ transactions: txs.filter(x => x !== t), stockLogs, products });
  assert.deepEqual(compareLedger(exp, verify().ledger), { missing: [], extra: [], diff: [] });
});
test('대조가 손댄 시트를 찾아낸다 (금액 고침 · 줄 지움 · 엉뚱한 줄 · 손으로 적은 줄)', () => {
  const sh = ledger();
  const head = sh.rows[0];
  const amt = head.indexOf('금액') + 1, key = head.indexOf('기록ID') + 1;
  sh.rows[9][amt - 1] = Number(sh.rows[9][amt - 1]) + 100;          // 10행 금액을 100원 고침
  const tamperedKey = sh.rows[9][key - 1];
  const goneKey = sh.rows[20][key - 1];
  sh.deleteRow(21);                                                   // 21행 지움
  sh.raw(sh.getLastRow() + 1, 3, '손으로 적은 줄');                   // 기록ID 없는 줄
  const rogue = sh.getLastRow() + 1;
  sh.raw(rogue, 3, '딸기 요거트'); sh.raw(rogue, key, 'tx:없는거래');   // 앱에 없는 기록ID
  const v = verify();
  const exp = expectedLedger({ transactions: txs.filter(x => x !== txs[5]), stockLogs, products });
  const cmp = compareLedger(exp, v.ledger);
  assert.ok(cmp.diff.some(d => d.key === tamperedKey && /금액/.test(d.why)), JSON.stringify(cmp.diff.slice(0, 3)));
  assert.ok(cmp.diff.some(d => d.key === goneKey) || cmp.missing.includes(goneKey));
  assert.deepEqual(cmp.extra, ['tx:없는거래']);
  assert.equal(v.handRows, 1);
  // 고치기 = replace / delete → 다시 대조하면 깨끗
  const fix = [...cmp.missing, ...cmp.diff.map(d => d.key)].map(k => ({ key: 'fix:' + k, op: 'replace', target: k, records: exp.get(k) }));
  fix.push(...cmp.extra.map(k => ({ key: 'del:' + k, op: 'delete', target: k })));
  assert.ok(send(fix).results.every(r => r.ok));
  sh.deleteRow(sh.rows.findIndex(r => r[2] === '손으로 적은 줄') + 1);   // 손으로 적은 줄은 사람이 지운다
  const again = compareLedger(exp, verify().ledger);
  assert.deepEqual(again, { missing: [], extra: [], diff: [] });
});
test('시트에 입력 규칙이 걸려 있으면 그 거래만 거절 · 반쪽 줄 없음 · 나머지는 적힘', () => {
  const sh = ledger();
  const payCol = sh.rows[0].indexOf('결제방식') + 1;
  sh.validators.push((r, c, v) => { if (c === payCol && v === '분할') throw new Error('입력한 데이터가 셀에 지정된 데이터 확인 규칙을 위반합니다'); });
  const a = { ...SALES[2000], id: 'V1', method: '분할', split: { cash: 1, transfer: SALES[2000].received - 1 } };
  if (a.received < 2) a.items = [{ title: '딸기 요거트', qty: 2, price: 3000 }], a.received = 6000, a.total = 6000, a.discount = 0, a.split = { cash: 1000, transfer: 5000 };
  const b = { ...SALES[2001], id: 'V2', method: '현금', split: null };
  const before = sh.getLastRow();
  const out = send([rowsOp(a), rowsOp(b)]);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, true);
  assert.equal(sh.getLastRow(), before + b.items.length, '거절된 거래의 반쪽 줄이 남으면 안 된다');
  assert.ok(sh.records().every(r => r.기록ID !== 'tx:V1'));
  sh.validators.pop();
  assert.ok(send([rowsOp(a)]).results[0].ok, '규칙을 풀면 다시 보낸 것이 적힌다');
  assert.equal(sh.records().filter(r => r.기록ID === 'tx:V1').length, a.items.length);
});

console.log('\n[4] 예약 탭');
const mkOrder = (id, extra = {}) => ({ id, no: Number(id.slice(1)), time: new Date(2026, 10, 3, 10, 30).toISOString(),
  name: '김예약', phone: '010-1111-2222', method: '계좌이체', paid: false, handed: false, note: '',
  items: [{ title: '딸기 요거트', qty: 2, price: 3000 }, { title: '귤 요거트', qty: 1, price: 3000 }], ...extra });
const orderOp = (o, rev) => ({ key: `order:${o.id}:${rev}`, op: 'order', id: o.id, rev, record: orderRecord(o) });
test('세트 예약: 금액 = 정가 − 세트 할인, 주문내역에 세트 표시 · 수령 거래도 맞는다', () => {
  const o = mkOrder('O7', { discount: 1000, discountLabel: '2개 세트', sets: [{ size: 2, disc: 1000, n: 1 }] });
  const r = orderRecord(o);
  assert.equal(r.금액, 8000);
  assert.equal(r.주문내역, '딸기 요거트 2, 귤 요거트 1 · 2개 세트 −1,000원');
  assert.equal(orderRecord(mkOrder('O8')).주문내역, '딸기 요거트 2, 귤 요거트 1');
  assert.equal(orderRecord(mkOrder('O9', { discount: 99999 })).금액, 0, '할인이 정가를 넘지 않는다');
  const t = { type: 'sale', time: o.time, items: o.items, total: 9000, discount: 1000, received: 8000,
    method: '계좌이체', discountLabel: '2개 세트', note: '예약 수령 #7' };
  const recs = txRecords(t);
  assert.deepEqual(checkTxRecords(t, recs), []);
  assert.equal(sum(recs.map(x => n0(x.할인))), 1000);
  assert.ok(recs[0].비고.startsWith('2개 세트'));
});
test('6개 세트(고정가): 할인 0원이어도 비고에 세트 표시 · 손 할인과 같이 적힘 · 옛 거래 비고는 그대로', () => {
  const items = ['딸기 요거트', '딸기 녹차초코', '바나나 다크초코', '바나나 녹차초코', '귤 요거트', '귤 화이트초코'].map(title => ({ title, qty: 1, price: 5500 }));
  const t0 = { type: 'sale', time: new Date(2026, 10, 8, 11).toISOString(), items, total: 33000, discount: 0, received: 33000, method: '현금', setLabel: '6개 세트' };
  const r0 = txRecords(t0);
  assert.equal(r0.length, 6);
  assert.ok(r0.every(r => r.비고 === '6개 세트' && r.수량 === 1));
  const t1 = { ...t0, items: items.map(i => ({ ...i, price: 6000 })), total: 36000, discount: 3500, received: 32500, discountLabel: '봉사자' };
  const r1 = txRecords(t1);
  assert.deepEqual(checkTxRecords(t1, r1), []);
  assert.equal(r1[0].비고, '6개 세트 · 봉사자');
  assert.equal(sum(r1.map(r => n0(r.금액))), 32500);
  const old = { ...t0, setLabel: undefined, discount: 1000, received: 32000, discountLabel: '2개 세트' };
  assert.equal(txRecords(old)[0].비고, '2개 세트');
  const o = mkOrder('O6', { items: items.map(i => ({ ...i, price: 5500 })), sets: [{ size: 6, n: 1, price: 33000, disc: 0 }], discount: 0, discountLabel: '6개 세트' });
  assert.equal(orderRecord(o).주문내역.endsWith(' · 6개 세트'), true);
  assert.equal(orderRecord(o).금액, 33000);
});
test('예약을 넣고 · 입금 · 수령을 바꾸면 같은 줄이 그 자리에서 바뀐다', () => {
  const o1 = mkOrder('O1'), o2 = mkOrder('O2', { name: '이두번' });
  send([orderOp(o1, 1), orderOp(o2, 2)]);
  assert.equal(orders().records().length, 2);
  send([orderOp({ ...o1, paid: true }, 3)]);
  send([orderOp({ ...o1, paid: true, handed: true }, 4)]);
  const recs = orders().records();
  assert.equal(recs.length, 2);
  assert.equal(recs[0].성함, '김예약');                 // 맨 밑으로 안 내려간다
  assert.equal(recs[0].입금, '입금');
  assert.equal(recs[0].수령, '수령');
});
test('늦게 도착한 옛 고치기는 새 값을 덮지 않는다', () => {
  send([orderOp(mkOrder('O1'), 1)]);                    // rev 1 이 다시 옴
  assert.equal(orders().records()[0].수령, '수령');
});
test('예약을 지우면 줄이 사라지고, 늦게 온 고치기가 되살리지 않는다', () => {
  send([{ key: 'orderdel:O2', op: 'orderdel', id: 'O2' }]);
  send([orderOp(mkOrder('O2'), 9)]);
  assert.deepEqual(orders().records().map(r => r.성함), ['김예약']);
});
test('예약 대조: 앱과 같으면 깨끗, 손대면 찾아낸다', () => {
  const app = [{ ...mkOrder('O1'), paid: true, handed: true }];
  assert.deepEqual(compareOrders(expectedOrders(app), verify().orders), { missing: [], extra: [], diff: [] });
  const sh = orders();
  sh.rows[1][sh.rows[0].indexOf('입금')] = '미입금';
  assert.equal(compareOrders(expectedOrders(app), verify().orders).diff.length, 1);
});

console.log('\n[5] 상품 이름 바꾸기 · 전체 초기화');
test('이름을 바꾸면 앱이 적은 줄만 새 이름이 된다', () => {
  const sh = ledger();
  sh.raw(sh.getLastRow() + 1, 3, '딸기 요거트');          // 손으로 적은 줄 (기록ID 없음)
  send([{ key: 'rename:1', op: 'rename', from: '딸기 요거트', to: '딸기 요거트 컵' }]);
  const recs = sh.records();
  assert.ok(!recs.some(r => r.기록ID && r.상품명 === '딸기 요거트'));
  assert.ok(recs.some(r => !r.기록ID && r.상품명 === '딸기 요거트'));
});
test('전체 초기화는 앱 줄만 지우고 손으로 적은 줄은 남긴다', () => {
  const out = S.post({ token: TOKEN, action: 'reset' });
  assert.ok(out.ok && out.removed > 0);
  assert.equal(ledger().records().filter(r => r.기록ID).length, 0);
  assert.equal(orders().records().length, 0);
  assert.ok(ledger().records().some(r => r.상품명 === '딸기 요거트'));
  // 초기화 뒤에는 같은 기록ID 도 다시 적힌다 (_전송기록 도 비웠으므로)
  assert.ok(send([rowsOp(txs[0])]).results[0].written > 0);
});

console.log(`\n${passed}개 통과${process.exitCode ? ' — 실패가 있습니다' : ''}`);

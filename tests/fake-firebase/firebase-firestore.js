// 시험용 가짜 Firestore — 메모리에만 둔다. 앱이 쓰는 함수만 흉내 낸다.
const store = new Map();               // 'col/id' → data
const listeners = new Set();
let auto = 0;
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
window.__fakeStore = store;
// 시험 서버의 시트 흉내로 바로 연결해 둔다
store.set('meta/sheet', { url: location.origin + '/sheet', token: 'e2e-token' });
export const initializeFirestore = () => ({ fake: true });
export const persistentLocalCache = () => ({});
export const persistentMultipleTabManager = () => ({});
export const collection = (db, name) => ({ kind: 'col', path: name });
export function doc(a, ...segs) {
  if (a.kind === 'col') {
    const id = segs[0] || ('auto' + (++auto).toString(36) + Math.random().toString(36).slice(2, 7));
    return { kind: 'doc', path: a.path + '/' + id, id };
  }
  return { kind: 'doc', path: segs.join('/'), id: segs[segs.length - 1] };
}
export const query = c => c;
export const increment = n => ({ __inc: n });
export const arrayUnion = (...v) => ({ __union: v });
function apply(prev, patch) {
  const out = { ...(prev || {}) };
  Object.entries(patch).forEach(([k, v]) => {
    if (v && typeof v === 'object' && '__inc' in v) out[k] = (out[k] || 0) + v.__inc;
    else if (v && typeof v === 'object' && '__union' in v) out[k] = [...(out[k] || []), ...clone(v.__union)];
    else out[k] = clone(v);
  });
  return out;
}
const write = (ref, data, merge) => store.set(ref.path, merge ? apply(store.get(ref.path), data) : apply(null, data));
const notify = () => queueMicrotask(() => listeners.forEach(l => l()));
const snapDoc = path => ({ id: path.split('/').pop(), ref: { kind: 'doc', path }, exists: () => store.has(path),
  data: () => clone(store.get(path)), metadata: { hasPendingWrites: false } });
const meta = { fromCache: false, hasPendingWrites: false };
const inCol = col => [...store.keys()].filter(p => p.startsWith(col + '/') && p.split('/').length === 2);
export async function setDoc(ref, data, opts) { write(ref, data, opts && opts.merge); notify(); }
export async function updateDoc(ref, patch) {
  if (!store.has(ref.path)) throw Object.assign(new Error('not-found ' + ref.path), { code: 'not-found' });
  write(ref, patch, true); notify();
}
export async function deleteDoc(ref) { store.delete(ref.path); notify(); }
export async function getDoc(ref) { return snapDoc(ref.path); }
export async function getDocs(col) { return { docs: inCol(col.path).map(snapDoc) }; }
export function onSnapshot(target, a, b) {
  const cb = typeof a === 'function' ? a : b;
  const fire = () => {
    if (target.kind === 'doc') cb({ ...snapDoc(target.path), metadata: meta });
    else cb({ docs: inCol(target.path).map(snapDoc), metadata: meta });
  };
  listeners.add(fire);
  setTimeout(fire, 0);
  return () => listeners.delete(fire);
}
export function writeBatch() {
  const ops = [];
  const b = {
    set(ref, d, o) { ops.push(() => write(ref, d, o && o.merge)); return b; },
    update(ref, d) { ops.push(() => { if (!store.has(ref.path)) throw new Error('not-found ' + ref.path); write(ref, d, true); }); return b; },
    delete(ref) { ops.push(() => store.delete(ref.path)); return b; },
    async commit() { ops.forEach(f => f()); notify(); },
  };
  return b;
}
export async function runTransaction(db, fn) {
  const ops = [];
  const tr = {
    get: async ref => snapDoc(ref.path),
    set(ref, d, o) { ops.push(() => write(ref, d, o && o.merge)); return tr; },
    update(ref, d) { ops.push(() => write(ref, d, true)); return tr; },
    delete(ref) { ops.push(() => store.delete(ref.path)); return tr; },
  };
  const out = await fn(tr);
  ops.forEach(f => f()); notify();
  return out;
}

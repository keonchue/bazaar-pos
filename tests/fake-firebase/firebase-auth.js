// 시험용 가짜 로그인 — 언제나 공용 계정으로 로그인된 상태
import { STORE_EMAIL } from '/firebase-config.js';
const auth = { currentUser: { email: STORE_EMAIL } };
export const getAuth = () => auth;
export const onAuthStateChanged = (a, cb) => setTimeout(() => cb(auth.currentUser), 0);
export const signInWithEmailAndPassword = async () => auth.currentUser;
export const signOut = async () => {};

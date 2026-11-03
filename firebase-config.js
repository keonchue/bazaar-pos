// ┌─────────────────────────────────────────────────────────────┐
// │  Firebase 설정 파일                                            │
// │  (이 값들은 비밀번호가 아니라 '주소' 같은 것이라 공개돼도 됩니다) │
// └─────────────────────────────────────────────────────────────┘
// SETUP-firebase.md 를 따라 만든 프로젝트의 config 값을 아래에 붙여 넣으세요.
// apiKey 가 '여기에' 로 시작하는 동안은 앱이 로그인 대신 연결 안내 화면을 띄웁니다.

export const firebaseConfig = {
  apiKey: "AIzaSyDTYJxPPFm32AZq2dLVbksEk3LxpztxTP0",
  authDomain: "bazaar-pos-95825.firebaseapp.com",
  projectId: "bazaar-pos-95825",
  storageBucket: "bazaar-pos-95825.firebasestorage.app",
  messagingSenderId: "299810827108",
  appId: "1:299810827108:web:b8c4c410ce199b00102871"
};

// 바자회 공용 로그인 계정 이메일 — firestore.rules 의 isStore() 안 주소와 반드시 같아야 합니다.
export const STORE_EMAIL = "fallbazaar@gmail.com";

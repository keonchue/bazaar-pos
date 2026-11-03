# 바자회 POS — Firebase 연결 안내 (약 10분)

**keonchue@gmail.com** 계정으로 아래를 해 주세요. 끝나면 **config 값**과 **공용 계정 이메일**만 알려 주시면 됩니다.

1. https://console.firebase.google.com → **프로젝트 만들기** → 이름 예) `bazaar-pos` (애널리틱스는 꺼도 됨)
2. **빌드 → Firestore Database → 데이터베이스 만들기** → 위치 `asia-northeast3 (서울)` → 프로덕션 모드
3. **빌드 → Authentication → 시작하기 → Sign-in method → 이메일/비밀번호** 사용 설정
4. **Authentication → Users → 사용자 추가** → 바자회 공용 이메일 · 비밀번호 (봉사자들과 공유할 것)
5. **⚙ 프로젝트 설정 → 내 앱 → 웹(`</>`)** 등록 → 나오는 `const firebaseConfig = { ... }` 복사
6. (배포 후) **Authentication → Settings → 승인된 도메인** 에 배포 주소 도메인 추가 (예: `keonchue.github.io`)

그다음 할 일 (제가 하거나 직접):
- `firebase-config.js` 에 config 와 `STORE_EMAIL` 넣기
- `firestore.rules` 의 이메일을 같은 주소로 바꾸고 **Firestore → 규칙** 에 붙여넣고 **게시**
  (게시 안 하면 로그인은 되는데 아무것도 저장되지 않습니다)

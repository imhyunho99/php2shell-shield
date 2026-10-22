# php2shell-shield

[English](README.md)

**PHP2Shell**(CVE-2026-109618, CVE-2026-109619)에 대응하는 임시 방어 도구입니다. 당장 PHP를 올리지 못하는 서버를 위해 만들었습니다.

- **`php2shell-shield`**: PHP 웹서버 앞에 두는 Go 리버스 프록시입니다. 공격에 쓰이는 요청 형태를 막고, 응답 쿠키로 새어 나가는 메모리를 걸러냅니다.
- **`php2shell-check`**: `php -i` 출력으로 해당 PHP가 패치됨, 완화됨, 취약 중 어디에 해당하는지 판정합니다.
- **Claude Code 스킬**: 레포나 서버에 있는 PHP를 모두 찾고, 패치하고, 침해 흔적을 점검하는 순서를 에이전트에게 지시합니다.

> **PHP 업그레이드가 유일한 완전한 해결책입니다.** 8.5.12, 8.4.27, 8.3.36, 8.2.35에서 고쳐졌습니다. 이 도구는 업그레이드할 시간을 버는 용도입니다.

## 쉴드가 하는 일

| 검사 | 이유 |
|---|---|
| `PHP_SESSION_UPLOAD_PROGRESS` 필드가 든 multipart 요청 거부 (403) | 공개된 공격 경로가 업로드 진행률 처리를 거칩니다. 파서 차이로 우회하지 못하도록 원본 바이트에서 대소문자를 무시하고 찾습니다. |
| 본문 크기 제한 (기본 16 MiB, 413) | 큰 페이로드로 워커를 메모리 부족 상태에 빠뜨립니다. |
| multipart 파트 수 제한 (기본 1000, 413) | 같은 이유입니다. |
| 파싱할 수 없는 multipart 거부 (400) | Go와 PHP가 해석을 달리하면 막는 쪽을 택합니다. |
| 올바르지 않은 `PHPSESSID` Set-Cookie 제거 | 메모리가 이 쿠키로 새어 나갑니다. 정상 세션 ID는 `[0-9A-Za-z,-]`로만 이루어지고 256자를 넘지 않습니다. |

탐지 결과는 한 줄짜리 JSON으로 stdout에 남깁니다. 오탐이 걱정되면 `-log-only`로 먼저 관찰한 뒤 차단을 켜면 됩니다.

PHP 자체를 고치지는 못합니다. FastCGI 구간은 보지 못하고, 아직 공개되지 않은 공격 경로도 막지 못합니다. 쉴드를 거치지 않고 PHP에 닿는 경로가 있으면 효과가 없습니다.

## 빠른 시작

```sh
go install github.com/imhyunho99/php2shell-shield/cmd/...@latest

# 1. 노출 여부 확인 (CLI가 아니라 웹 SAPI 기준으로)
php2shell-check -php php-fpm8.3
docker exec web php -i | php2shell-check -stdin

# 2. 웹서버를 내부 포트로 옮기고 앞에 쉴드를 둡니다
php2shell-shield -listen :80 -upstream http://127.0.0.1:8080
```

Docker 예시는 [`deploy/docker-compose.yml`](deploy/docker-compose.yml)에 있습니다.

## 당장 적용할 PHP 설정

PHP 보안 공지에 나온 설정입니다. 앱이 덮어쓰지 못하는 위치(메인 `php.ini`, FPM 풀의 `php_admin_value`)에 넣고, 워커를 모두 재시작하세요.

```ini
memory_limit = -1                   ; CVE-2026-109618. 컨테이너/cgroup 메모리 제한을 함께 걸 것
session.upload_progress.enabled = 0 ; CVE-2026-109619
fatal_error_backtraces = 0          ; PHP 8.5만 해당
```

## 침해 흔적

2026-10-17 이후 기록을 확인하세요.

- multipart POST에서 500 응답이나 `Allowed memory size … exhausted`가 몰려 있는 경우
- `%`가 들어 있거나 256자를 넘는 `PHPSESSID` 응답 쿠키 (쉴드는 `session-cookie-leak`으로 기록)
- 원인을 모르는 PHP 워커 재시작이나 크래시
- 웹 루트나 업로드 디렉터리에 새로 생긴 `.php` 파일

하나라도 보이면 워커 메모리에 있던 비밀값이 노출됐다고 보고 DB 비밀번호, API 키, 세션 서명 키를 교체하세요. 서버는 검증된 이미지에서 다시 빌드하는 편이 안전합니다.

자세한 옵션, 종료 코드, 스킬 설치 방법은 [영문 README](README.md)에 있습니다.

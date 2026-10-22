# php2shell-shield

[English](README.md)

**PHP2Shell**(CVE-2026-109618, CVE-2026-109619)에 대응하는 임시 방어 도구입니다. 당장 PHP를 올리지 못하는 서버를 위해 만들었습니다.

- **`php2shell-shield`**: PHP 웹서버 앞에 두는 Go 리버스 프록시입니다. 공개된 공격 경로에 필요한 요청 형태를 막고, 응답 쿠키로 새어 나가는 메모리를 걸러냅니다.
- **`php2shell-check`**: `php -i` 출력으로 패치됨, 부분 완화, 취약 중 어디에 해당하는지 판정합니다.
- **Claude Code 스킬**: 레포나 서버에 있는 PHP를 모두 찾아 패치하고 침해 흔적을 점검하는 순서를 에이전트에게 지시합니다.

> **PHP를 업그레이드하세요.** 8.5.12, 8.4.27, 8.3.36, 8.2.35(그리고 8.6.0 RC4)에서 두 버그가 모두 고쳐졌습니다. PHP 공지 원문은 "완전한 완화책은 없으며 업데이트만이 안전한 선택"입니다. 이 도구는 업그레이드 전까지 일부 공격 경로를 좁힐 뿐, 서버를 안전하게 만들지는 않습니다.

## PHP2Shell이란

PHP 엔진의 버그 두 개이고, 각각 CVSS v4.0 9.2점입니다.

- **CVE-2026-109618 (메모리 부족 시 손상)**: 요청 데이터가 절반만 초기화된 상태에서 메모리가 바닥나면, 정리 단계가 그 데이터를 유효한 값으로 취급합니다.
- **CVE-2026-109619 (전역 상태 잔존)**: 요청이 쓰던 상태가 메모리 해제 뒤에도 남아 있다가, 같은 워커의 다음 요청에서 사용됩니다.

공격자는 요청 하나로 상태를 심고, 다음 요청으로 그 상태를 사용하게 만듭니다. 확인된 경로는 다음과 같습니다.

1. **세션 업로드 진행률**: 기본으로 켜져 있고 `session_start()` 없이도 동작합니다. Wiz는 이 경로로 워커 메모리가 세션 쿠키에 담겨 새어 나가는 것을 보였습니다.
2. **치명적 오류 백트레이스 (PHP 8.5)**: 가장 강한 경로이며 mod_php에서 원격 코드 실행이 확인됐습니다.
3. **요청 시작 전 INI 경고**: mod_php의 `.htaccess`, `php_value` 등에서 나오는 경고나 deprecation도 해당합니다.
4. **종료·정리 단계의 경고**, 그리고 앱에 따라 남는 기타 상태.

메모리 고갈에 큰 본문이 꼭 필요하지는 않습니다. multipart 파트 하나에 헤더를 무제한으로 넣을 수 있고, 이 헤더가 PHP 안에서 훨씬 큰 메모리를 차지합니다. 빈 파일 필드와 깊게 중첩된 필드 이름도 부담을 키웁니다.

PHP-FPM, mod_php, php-cgi, FrankenPHP, LiteSpeed를 포함해 웹 요청을 처리하는 모든 PHP가 영향을 받습니다. PHP는 mod_php를 가장 위험하다고 봤고, FPM에서도 코드 실행이 확인됐습니다.

## 쉴드가 막는 것과 못 막는 것

| 검사 | 대응 대상 |
|---|---|
| 업로드 진행률 필드가 든 multipart 거부 (403) | 경로 1의 트리거. `session.upload_progress.name`을 바꿨다면 `-progress-fields`로 지정 |
| multipart 파트별 헤더 수·크기 제한 (8개, 4 KiB; 431) | 헤더 증폭으로 메모리 고갈 유도 |
| 필드 이름 `[` 중첩 깊이 제한 (8; 400) | 중첩 이름 증폭 |
| multipart 파트 수 제한 (1000; 413) | 빈 파일 필드·파트 수 증폭 |
| 본문 크기 제한 (16 MiB; 413, chunked 포함) | 본문을 받아 실제 `Content-Length`를 붙여 넘기므로, 길이 없는 요청이 PHP에 그대로 닿지 않습니다 |
| 파싱할 수 없는 multipart, 중복 `Content-Type` 거부 (400) | 파서 차이로 인한 우회 |
| `-block-multipart` (415) | 업로드를 안 쓰는 앱에 대한 PHP 권고 |
| 올바르지 않은 세션 쿠키 제거 | 메모리 유출 통로. `session.name`을 바꿨다면 `-session-cookies`로 지정 |

경로 2~4는 PHP 내부(앱의 치명적 오류, INI 경고, 종료 단계 경고)에서 일어나서 **프록시로는 막을 수 없습니다**. 아래 PHP 설정과 업그레이드로만 대응됩니다.

## 빠른 시작

```sh
# 1. 노출 여부 확인 (CLI가 아니라 웹 SAPI 기준으로)
php2shell-check -php php-fpm8.3
docker exec web php -i | php2shell-check -stdin

# 2. 웹서버를 내부 포트로 옮기고 앞에 쉴드를 둡니다
php2shell-shield -listen :80 -upstream http://127.0.0.1:8080
```

바이너리는 [Releases](https://github.com/imhyunho99/php2shell-shield/releases)에 있고, 컨테이너 이미지는 `ghcr.io/imhyunho99/php2shell-shield:latest`입니다. 배포 예시(docker-compose, nginx, systemd)는 `deploy/`에 있습니다.

## 당장 적용할 PHP 설정

[php.net 공지](https://www.php.net/archive/2026.php)에 나온 설정입니다. `ini_set()`이나 `.user.ini`가 아니라 `php.ini`, FPM 풀(`php_admin_value`), 서버 설정에 넣고 워커를 모두 재시작하세요.

```ini
memory_limit = -1                   ; 109618. 다른 곳에서 유한값으로 되돌리지 않는지 확인
session.upload_progress.enabled = 0 ; 109619 세션 경로. 안 쓰면 패치 후에도 꺼 둘 것
fatal_error_backtraces = 0          ; 109619, PHP 8.5만 해당
post_max_size = 8M                  ; 업로드가 필요하면 32M, upload_max_filesize는 그보다 작게
```

- 메모리 상한은 cgroup이나 컨테이너 제한으로 거세요. `RLIMIT_AS`/`RLIMIT_DATA`는 **쓰면 안 됩니다**. 그 한도에 닿는 순간 버그가 발동합니다.
- 요청 시작 전에 경고를 내는 잘못되거나 deprecated된 INI 설정을 지우세요. `@`나 `display_errors`로 숨기는 것은 소용없습니다.
- 공격자가 일으킬 수 있는 치명적 오류와 실행 시간 초과를 고치세요.
- 성능이 허락하면 `pm.max_requests = 1`로 매 요청마다 워커를 교체하세요.

## 침해 흔적

AWS는 2026-10-21 공개 이전부터 허니팟에서 공격 시도를 관측했다고 밝혔습니다. 적어도 10월 중순부터 기록을 확인하세요.

- 특히 multipart POST에 몰린 500 응답, `Allowed memory size … exhausted`, 치명적 오류, 시간 초과
- `%`가 들어 있거나 256자를 넘는 세션 응답 쿠키 (쉴드는 `session-cookie-leak`으로 기록)
- 원인을 모르는 PHP 워커 크래시나 재시작
- 웹 루트나 업로드 디렉터리에 새로 생긴 `.php` 파일

로그가 깨끗하다고 안전한 것은 아닙니다. PHP가 메시지를 남기기 전에 일어나는 실패도 있습니다. 흔적이 보이면 워커 메모리에 있던 비밀값이 노출됐다고 보고 DB 비밀번호, API 키, 세션 서명 키를 교체하세요. 세션도 무효화하고, 서버는 검증된 이미지에서 다시 빌드하세요.

전체 옵션, 종료 코드, 스킬 설치 방법은 [영문 README](README.md)에 있습니다.

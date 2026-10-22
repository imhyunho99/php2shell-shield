<?php
// Emits a PHPSESSID cookie shaped like PHP2Shell's leak (URL-encoded heap).
// Test fixture only; nothing here exploits PHP.
header('Set-Cookie: PHPSESSID=' . rawurlencode("\x00\x00\xa8\x7fpassword=hunter2") . '; path=/');
echo "ok\n";

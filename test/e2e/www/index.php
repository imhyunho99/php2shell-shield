<?php
session_start();
$_SESSION['n'] = ($_SESSION['n'] ?? 0) + 1;
header('Content-Type: text/plain');
echo "visits=", $_SESSION['n'], "\n";
foreach ($_FILES as $k => $f) {
    echo "file $k ", $f['size'], "\n";
}
foreach ($_POST as $k => $v) {
    echo "post $k\n";
}

<?php
// A tiny "legacy" PHP app: front controller, sessions, uploads.
session_start();
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if ($path === '/login' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $_SESSION['user'] = ['name' => $_POST['name'] ?? 'guest', 'roles' => ['member']];
    header('Location: /');
    exit;
}
if ($path === '/upload' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $f = $_FILES['file'] ?? null;
    header('Content-Type: application/json');
    echo json_encode(['name' => $f['name'] ?? null, 'size' => $f['size'] ?? 0, 'error' => $f['error'] ?? -1]);
    exit;
}
if ($path === '/whoami') {
    header('Content-Type: application/json');
    echo json_encode(['servedBy' => 'php', 'user' => $_SESSION['user'] ?? null, 'php' => PHP_VERSION]);
    exit;
}
header('Content-Type: text/html; charset=utf-8');
$name = htmlspecialchars($_SESSION['user']['name'] ?? 'stranger');
echo "<h1>Hello, {$name}</h1><p>served by PHP " . PHP_VERSION . "</p>";

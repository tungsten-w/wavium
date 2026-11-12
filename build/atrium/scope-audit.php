<?php
/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Scope regression check. Lists every route with the scope a token needs and
 * flags routes that may be mis-scoped:
 *   ADMIN-IN-CODE    normal-user route that checks admin/subadmin in its body
 *   GET-SIDE-EFFECT? GET route (default read scope) whose body seems to write
 *   TOKEN-WRITE      code that writes oc_authtoken.scope or creates/rebuilds a token
 * Flags already reviewed are listed in scope-audit-reviewed.txt; anything new
 * makes the script exit 1.
 *
 * Run on an installed instance (as the web user):
 *   php occ router:list --output=json > /tmp/routes.json
 *   php build/atrium/scope-audit.php /tmp/routes.json [--all]
 */
require __DIR__ . '/../../lib/base.php';
use OCP\AppFramework\Http\Attribute as A;
$appManager = \OCP\Server::get(\OCP\App\IAppManager::class);
$routes = json_decode(file_get_contents($argv[1]), true);
$index = []; // app => [normalized controller => class]
$dirs = ['core' => __DIR__ . '/../../core/Controller'];
foreach ($appManager->getEnabledApps() as $app) { $p = $appManager->getAppPath($app) . '/lib/Controller'; if (is_dir($p)) $dirs[$app] = $p; }
foreach ($dirs as $app => $dir) {
	$ns = $app === 'core' ? 'OC\\Core' : \OC\AppFramework\App::buildAppNamespace($app);
	foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir)) as $f) {
		if ($f->getExtension() !== 'php') continue;
		$rel = substr($f->getPathname(), strlen($dir) + 1, -4);
		$key = strtolower(str_replace(['_', '/'], '', preg_replace('/Controller$/', '', basename($rel))));
		$index[$app][$key] = $ns . '\\Controller\\' . str_replace('/', '\\', $rel);
	}
}
$has = fn ($r, string $short, string $cls) => $r->getAttributes($cls) !== [] || preg_match('/@' . $short . '\b/', $r->getDocComment() ?: '');
$out = fopen('php://stdout', 'w');
$all = in_array('--all', $argv, true);
$reviewed = [];
foreach (file(__DIR__ . '/scope-audit-reviewed.txt', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
	if ($line[0] !== '#') { $parts = explode(' ', trim($line), 2); $reviewed[strtolower($parts[0])] = $parts[1] ?? ''; }
}
$new = 0;
foreach ($routes as $route) {
	$p = explode('.', $route['route']);
	if ($p[0] === 'ocs') array_shift($p);
	if (count($p) < 3) { if ($all) fputcsv($out, [$route['route'], $route['request'], $route['path'], '-', 'UNRESOLVED'], "\t", '"', ''); continue; }
	[$app, $ctl, $method] = $p;
	$class = $index[$app][strtolower(str_replace('_', '', $ctl))] ?? null;
	try { $rm = $class ? new ReflectionMethod($class, str_replace('_', '', $method)) : null; } catch (\Throwable) { $rm = null; }
	if ($rm === null) { if ($all) fputcsv($out, [$route['route'], $route['request'], $route['path'], '-', 'UNRESOLVED'], "\t", '"', ''); continue; }
	$v = $route['request'];
	$public = $has($rm, 'PublicPage', A\PublicPage::class);
	$admin = $has($rm, 'AuthorizedAdminSetting', A\AuthorizedAdminSetting::class) || $has($rm, 'SubAdminRequired', A\SubAdminRequired::class) || !$has($rm, 'NoAdminRequired', A\NoAdminRequired::class);
	$attr = $rm->getAttributes(A\RequireScope::class)[0] ?? (new ReflectionClass($class))->getAttributes(A\RequireScope::class)[0] ?? null;
	$ov = \OC\Authentication\Scope\RouteScopes::lookup($class, $rm->getName());
	$act = in_array($v, ['GET', 'HEAD', 'GET|HEAD'], true) ? 'read' : ($v === 'DELETE' ? 'delete' : 'write');
	$req = [];
	if ($public) $req = ['public'];
	else {
		if ($admin) $req[] = "admin:$act";
		if ($attr) { $i = $attr->newInstance(); $req[] = $i->getArea() . ':' . $i->getAction(); }
		elseif ($ov) foreach ($ov as $s) $req[] = implode(':', $s);
		elseif (!$req) $req[] = \OC\Authentication\Scope\ScopeRegistry::areaForApp($app) . ":$act";
	}
	$src = implode('', array_slice(file($rm->getFileName()), $rm->getStartLine() - 1, $rm->getEndLine() - $rm->getStartLine() + 1));
	$flags = [];
	if (!$public && !$admin && !$attr && !$ov && preg_match('/->(isAdmin|isSubAdmin|isDelegatedAdmin|isUserAccessible|isSubAdminOfGroup|getSubAdmin)\(/', $src, $m)) $flags[] = 'ADMIN-IN-CODE(' . $m[1] . ')';
	if ($act === 'read' && !$public && !$attr && !$ov && preg_match('/->(setUserValue|setAppValue|setValue\w*|deleteUserValue|deleteAppValue|delete\w*|insert|update\w*|save|persist|send\w*|create\w*|mark\w*|remove\w*|newFile|touch|writeStream|add\w*|sync\w*|wipe\w*)\(/', $src, $m)) $flags[] = 'GET-SIDE-EFFECT?(' . $m[1] . ')';
	$key = ltrim($class, '\\') . '::' . $rm->getName();
	if ($flags !== [] && !isset($reviewed[strtolower($key)])) {
		$new++;
		$flags[] = 'NEW';
	}
	if ($all || in_array('NEW', $flags, true)) {
		fputcsv($out, [$route['route'], $v, $key, implode(' + ', $req), implode(' ', $flags)], "\t", '"', '');
	}
}
// TOKEN-WRITE: code that writes oc_authtoken.scope or creates/rebuilds a
// token. Each must carry the "atrium" key through (or be unreachable for
// scoped tokens). Reviewed per file with the number of sites, so a new site
// in a reviewed file is flagged too: "token-write:<path> <count> <reason>".
$root = realpath(__DIR__ . '/../..');
$pattern = '/\$\w*token\w*->setScope\(|rovider->(generateToken|rotate|renewSessionToken)\(|->set\(\s*[\'"]scope[\'"]/i';
// custom_apps too: apps installed from the app store on the instance.
foreach (array_filter(['lib', 'core', 'apps', 'custom_apps'], fn ($d) => is_dir("$root/$d")) as $top) {
	foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$root/$top", FilesystemIterator::SKIP_DOTS)) as $f) {
		$rel = substr($f->getPathname(), strlen($root) + 1);
		if ($f->getExtension() !== 'php' || preg_match('#/(tests?|vendor|3rdparty|node_modules)/#', $rel)) continue;
		$count = preg_match_all($pattern, file_get_contents($f->getPathname()));
		if ($count === 0) continue;
		$key = strtolower("token-write:$rel");
		$ok = isset($reviewed[$key]) && (int)explode(' ', $reviewed[$key])[0] === $count;
		if (!$ok) $new++;
		if ($all || !$ok) fputcsv($out, ['-', '-', $rel, "$count site(s)", 'TOKEN-WRITE' . ($ok ? '' : ' NEW')], "\t", '"', '');
	}
}
fwrite(STDERR, $new === 0 ? "scope audit: no unreviewed flags\n" : "scope audit: $new unreviewed route(s) or token write(s), review them or add them to scope-audit-reviewed.txt\n");
exit($new === 0 ? 0 : 1);

<?php

/**
 * SPDX-FileCopyrightText: 2016-2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-FileCopyrightText: 2016 ownCloud, Inc.
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
namespace OC\Core\Controller;

use OC\IntegrityCheck\Checker;
use OC\Setup;
use OCP\Defaults;
use OCP\IURLGenerator;
use OCP\Server;
use Psr\Log\LoggerInterface;

/**
 * Atrium runs in containers only (docs/architecture/0001-containers-only.md):
 * there is no web installer. A new instance installs itself from the container
 * environment (NEXTCLOUD_ADMIN_USER/PASSWORD + POSTGRES_* -> occ maintenance:install,
 * or a complete autoconfig.php). Until then every page shows how to do that.
 */
class SetupController {
	private string $autoConfigFile;

	public function __construct(
		protected Setup $setupHelper,
		protected LoggerInterface $logger,
		protected Defaults $defaults,
	) {
		$this->autoConfigFile = \OC::$configDir . 'autoconfig.php';
	}

	public function run(array $post): void {
		// Only a complete autoconfig.php may install from a web request; POSTed
		// form data is ignored.
		$auto = $this->loadAutoConfig([]);
		if (!$this->setupHelper->canInstallFileExists() || ($auto['install'] ?? '') !== 'true') {
			$this->notInstalled([]);
			return;
		}
		if (isset($auto['adminpassword'])) {
			$auto['adminpass'] = $auto['adminpassword'];
		}
		if (isset($auto['dbpassword'])) {
			$auto['dbpass'] = $auto['dbpassword'];
		}
		$errors = $this->setupHelper->install($auto);
		if (count($errors) > 0) {
			$this->notInstalled($errors);
			return;
		}
		if (file_exists($this->autoConfigFile)) {
			unlink($this->autoConfigFile);
		}
		Server::get(Checker::class)->runInstanceVerification();
		header('Location: ' . Server::get(IURLGenerator::class)->getAbsoluteURL('/'));
		exit();
	}

	/**
	 * @param list<array{error: string, hint?: string}|string> $errors
	 */
	private function notInstalled(array $errors): void {
		http_response_code(503);
		header('Content-Type: text/html; charset=utf-8');
		header('Cache-Control: no-store');
		$e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
		$name = $e($this->defaults->getProductName());
		$list = '';
		foreach ($errors as $error) {
			$text = is_array($error) ? ($error['error'] ?? '') . (isset($error['hint']) ? ' — ' . $error['hint'] : '') : (string)$error;
			$list .= '<li>' . $e($text) . '</li>';
		}
		$list = $list !== '' ? "<p>The installation failed:</p><ul>$list</ul>" : '';
		echo <<<HTML
			<!doctype html>
			<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
			<title>$name: not installed</title>
			<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1em .3em;border-radius:4px}</style>
			</head><body>
			<h1>$name is not installed yet</h1>
			$list
			<p>$name installs itself when its container starts with <code>NEXTCLOUD_ADMIN_USER</code>,
			<code>NEXTCLOUD_ADMIN_PASSWORD</code> and the database variables (<code>POSTGRES_*</code>) set,
			or run <code>occ maintenance:install</code> in the container.</p>
			</body></html>
			HTML;
	}

	public function loadAutoConfig(array $post): array {
		if (file_exists($this->autoConfigFile)) {
			$this->logger->info('Autoconfig file found, setting up Nextcloud…');
			$AUTOCONFIG = [];
			include $this->autoConfigFile;
			$post['hasAutoconfig'] = count($AUTOCONFIG) > 0;
			$post = array_merge($post, $AUTOCONFIG);
		}

		$dbIsSet = isset($post['dbtype']);
		$directoryIsSet = isset($post['directory']);
		$adminAccountIsSet = isset($post['adminlogin']);

		if ($dbIsSet && $directoryIsSet && $adminAccountIsSet) {
			$post['install'] = 'true';
		}

		return $post;
	}
}

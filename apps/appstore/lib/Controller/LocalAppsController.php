<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Appstore\Controller;

use OC\App\AppManager;
use OC\App\InfoParser;
use OC\Installer;
use OCA\Appstore\AppInfo\Application;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\ApiRoute;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\Attribute\PasswordConfirmationRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\OCS\OCSBadRequestException;
use OCP\AppFramework\OCS\OCSException;
use OCP\AppFramework\OCSController;
use OCP\IRequest;
use OCP\Security\ISecureRandom;
use Psr\Log\LoggerInterface;

/**
 * Atrium's decentralized app store: every app in the apps directories can be
 * enabled or disabled, and more apps come from a git URL (cloned into the
 * writable apps directory). Nothing here talks to apps.nextcloud.com.
 */
#[OpenAPI(scope: OpenAPI::SCOPE_ADMINISTRATION)]
class LocalAppsController extends OCSController {
	public function __construct(
		IRequest $request,
		private readonly AppManager $appManager,
		private readonly Installer $installer,
		private readonly InfoParser $infoParser,
		private readonly ISecureRandom $random,
		private readonly LoggerInterface $logger,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	/**
	 * List every app found in the apps directories
	 *
	 * @return DataResponse<Http::STATUS_OK, list<array{id: string, name: string, summary: string, version: string, active: bool, shipped: bool, internal: bool, removable: bool, icon: ?string, groups: list<string>, git: ?array{url: string, commit: string}, updatable: bool}>, array{}>
	 *
	 * 200: Apps returned
	 */
	#[ApiRoute(verb: 'GET', url: '/api/v1/local')]
	public function index(): DataResponse {
		$installPath = $this->writablePath();
		$always = $this->appManager->getAlwaysEnabledApps();
		$apps = [];
		foreach (array_unique($this->appManager->getAllAppsInAppsFolders()) as $id) {
			$info = $this->appManager->getAppInfo($id);
			if ($info === null) {
				continue;
			}
			try {
				$path = $this->appManager->getAppPath($id);
			} catch (\Throwable) {
				continue;
			}
			$shipped = $this->appManager->isShipped($id);
			$inWritable = $installPath !== null && dirname($path) === $installPath;
			$groups = json_decode((string)\OCP\Server::get(\OCP\IAppConfig::class)->getValueString($id, 'enabled', 'no'), true);
			$apps[] = [
				'id' => $id,
				'name' => (string)($info['name'] ?? $id),
				'summary' => (string)($info['summary'] ?? ''),
				'version' => $this->appManager->getAppVersion($id),
				'active' => $this->appManager->isEnabledForAnyone($id),
				'shipped' => $shipped,
				'internal' => in_array($id, $always, true),
				'removable' => $inWritable && !$shipped,
				'icon' => $this->icon($id, $path),
				'groups' => is_array($groups) ? array_values(array_map('strval', $groups)) : [],
				'git' => $this->gitInfo($path),
				'updatable' => $this->appManager->isUpgradeRequired($id),
			];
		}
		usort($apps, fn ($a, $b) => [$b['active'], strtolower($a['name'])] <=> [$a['active'], strtolower($b['name'])]);
		return new DataResponse($apps);
	}

	/**
	 * Install an app from a git repository and enable it
	 *
	 * The repository must contain the app at its root (appinfo/info.xml) with
	 * its built assets, like a release branch or tag.
	 *
	 * @param string $url https:// or http:// git URL
	 * @param string $ref Branch or tag to check out (default branch if empty)
	 * @return DataResponse<Http::STATUS_OK, array{id: string, name: string, version: string}, array{}>
	 * @throws OCSException
	 *
	 * 200: App installed and enabled
	 */
	#[PasswordConfirmationRequired(strict: true)]
	#[ApiRoute(verb: 'POST', url: '/api/v1/local/git')]
	public function installFromGit(string $url, string $ref = ''): DataResponse {
		$url = trim($url);
		$scheme = strtolower((string)parse_url($url, PHP_URL_SCHEME));
		if (!in_array($scheme, ['https', 'http'], true) || parse_url($url, PHP_URL_HOST) === null || preg_match('/\s/', $url)) {
			throw new OCSBadRequestException('Use an https:// git URL');
		}
		if ($ref !== '' && !preg_match('/^[A-Za-z0-9._\/-]{1,200}$/', $ref)) {
			throw new OCSBadRequestException('Invalid branch or tag');
		}
		$installPath = $this->writablePath();
		if ($installPath === null) {
			throw new OCSException('No writable apps directory', Http::STATUS_INTERNAL_SERVER_ERROR);
		}
		$tmp = $installPath . '/.atrium-clone-' . $this->random->generate(12, ISecureRandom::CHAR_LOWER . ISecureRandom::CHAR_DIGITS);
		try {
			$args = ['clone', '--depth', '1'];
			if ($ref !== '') {
				array_push($args, '--branch', $ref);
			}
			array_push($args, '--', $url, $tmp);
			$this->git($args);
			$info = is_file($tmp . '/appinfo/info.xml') ? $this->infoParser->parse($tmp . '/appinfo/info.xml') : null;
			$id = is_array($info) ? (string)($info['id'] ?? '') : '';
			if (!preg_match('/^[a-z0-9_]{1,64}$/', $id)) {
				throw new OCSBadRequestException('No valid appinfo/info.xml at the root of this repository');
			}
			try {
				$this->appManager->getAppPath($id, true);
				throw new OCSBadRequestException("An app with the id \"$id\" is already installed");
			} catch (\OCP\App\AppPathNotFoundException) {
			}
			if (!rename($tmp, $installPath . '/' . $id)) {
				throw new OCSException('Could not move the app into place', Http::STATUS_INTERNAL_SERVER_ERROR);
			}
			$this->appManager->clearAppsCache();
			$this->installer->installApp($id);
			$this->appManager->enableApp($id);
			$this->logger->info("Installed app $id from git $url", ['app' => Application::APP_ID]);
			return new DataResponse(['id' => $id, 'name' => (string)($info['name'] ?? $id), 'version' => (string)($info['version'] ?? '')]);
		} catch (OCSException $e) {
			throw $e;
		} catch (\Throwable $e) {
			$this->logger->warning('Git app install failed: ' . $e->getMessage(), ['app' => Application::APP_ID, 'exception' => $e]);
			throw new OCSException($e->getMessage(), Http::STATUS_INTERNAL_SERVER_ERROR);
		} finally {
			if (is_dir($tmp)) {
				\OCP\Files::rmdirr($tmp);
			}
		}
	}

	/**
	 * Pull the latest commit of a git-installed app and run its migrations
	 *
	 * @param string $appId
	 * @return DataResponse<Http::STATUS_OK, array{id: string, version: string, commit: string}, array{}>
	 * @throws OCSException
	 *
	 * 200: App updated
	 */
	#[PasswordConfirmationRequired(strict: true)]
	#[ApiRoute(verb: 'POST', url: '/api/v1/local/git/update')]
	public function updateFromGit(string $appId): DataResponse {
		$path = $this->appManager->getAppPath($appId);
		$installPath = $this->writablePath();
		if ($installPath === null || dirname($path) !== $installPath || !is_dir($path . '/.git')) {
			throw new OCSBadRequestException('This app was not installed from git');
		}
		$this->git(['-C', $path, 'pull', '--ff-only', '--depth', '1']);
		$this->appManager->clearAppsCache();
		if ($this->appManager->isUpgradeRequired($appId)) {
			$this->appManager->upgradeApp($appId);
		}
		return new DataResponse(['id' => $appId, 'version' => $this->appManager->getAppVersion($appId, false), 'commit' => $this->gitInfo($path)['commit'] ?? '']);
	}

	private function writablePath(): ?string {
		try {
			return $this->installer->getInstallPath();
		} catch (\RuntimeException) {
			return null;
		}
	}

	/** @param list<string> $args */
	private function git(array $args): string {
		$proc = proc_open(['timeout', '300', 'git', ...$args], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, [
			'GIT_TERMINAL_PROMPT' => '0',
			'GIT_ASKPASS' => '/bin/false',
			'HOME' => sys_get_temp_dir(),
			'PATH' => getenv('PATH') ?: '/usr/local/bin:/usr/bin:/bin',
		]);
		if (!is_resource($proc)) {
			throw new OCSException('git is not available', Http::STATUS_INTERNAL_SERVER_ERROR);
		}
		$out = stream_get_contents($pipes[1]);
		$err = stream_get_contents($pipes[2]);
		fclose($pipes[1]);
		fclose($pipes[2]);
		$code = proc_close($proc);
		if ($code !== 0) {
			$msg = trim((string)$err) ?: "git exited with $code";
			throw new OCSBadRequestException('git: ' . mb_substr($msg, 0, 400));
		}
		return (string)$out;
	}

	/** @return ?array{url: string, commit: string} */
	private function gitInfo(string $path): ?array {
		if (!is_dir($path . '/.git')) {
			return null;
		}
		$url = '';
		$config = @file_get_contents($path . '/.git/config');
		if ($config !== false && preg_match('/\[remote "origin"\][^\[]*?url\s*=\s*(\S+)/s', $config, $m)) {
			$url = $m[1];
		}
		$commit = '';
		$head = trim((string)@file_get_contents($path . '/.git/HEAD'));
		if (str_starts_with($head, 'ref: ')) {
			$commit = trim((string)@file_get_contents($path . '/.git/' . substr($head, 5)));
			if ($commit === '' && is_file($path . '/.git/packed-refs')) {
				$ref = preg_quote(substr($head, 5), '/');
				if (preg_match('/^([0-9a-f]{40}) ' . $ref . '$/m', (string)file_get_contents($path . '/.git/packed-refs'), $m)) {
					$commit = $m[1];
				}
			}
		} else {
			$commit = $head;
		}
		return ['url' => $url, 'commit' => substr($commit, 0, 12)];
	}

	private function icon(string $id, string $path): ?string {
		foreach (['app-dark.svg', 'app.svg'] as $f) {
			if (is_file("$path/img/$f")) {
				try {
					return $this->appManager->getAppWebPath($id) . "/img/$f";
				} catch (\Throwable) {
				}
			}
		}
		return null;
	}
}

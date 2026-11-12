<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Authentication\Scope;

use OCP\App\IAppManager;
use OCP\Authentication\Scope\IScopeRegistry;

class ScopeRegistry implements IScopeRegistry {
	private const R = self::ACTION_READ;
	private const W = self::ACTION_WRITE;
	private const D = self::ACTION_DELETE;
	private const S = self::ACTION_SEND;
	private const SH = self::ACTION_SHARE;

	/** Areas that always exist. */
	public const CORE_AREAS = [
		'files' => [self::R, self::W, self::D, self::SH],
		'calendar' => [self::R, self::W, self::D, self::SH],
		'contacts' => [self::R, self::W, self::D, self::SH],
		'tasks' => [self::R, self::W, self::D],
		// Core routes (capabilities, avatars, navigation, ...): read is granted to every scoped token.
		'core' => [self::R, self::W],
		// Unified search spans every app, so it is its own grant.
		'search' => [self::R],
		self::AREA_ACCOUNT => [self::R, self::W],
		self::AREA_SECURITY => [self::R, self::W],
		self::AREA_ADMIN => [self::R, self::W],
	];

	/**
	 * Third-party apps we cannot annotate, declared here instead of in their
	 * info.xml. See RouteScopes for their route mapping.
	 */
	public const KNOWN_APPS = [
		'mail' => [self::R, self::W, self::S, self::D, self::SH],
	];

	/**
	 * Apps whose routes belong to another area (default action still comes
	 * from the HTTP method unless RouteScopes or an attribute says otherwise).
	 */
	public const APP_AREA = [
		'files' => 'files',
		'files_trashbin' => 'files',
		'files_versions' => 'files',
		'files_reminders' => 'files',
		'files_sharing' => 'files',
		'files_downloadlimit' => 'files',
		'viewer' => 'files',
		'dav' => 'files',
		'calendar' => 'calendar',
		'contacts' => 'contacts',
		'contactsinteraction' => 'contacts',
		'tasks' => 'tasks',
		'settings' => self::AREA_ACCOUNT,
		'profile' => self::AREA_ACCOUNT,
		'user_status' => self::AREA_ACCOUNT,
		'theming' => self::AREA_ACCOUNT,
		'provisioning_api' => self::AREA_ACCOUNT,
		'twofactor_backupcodes' => self::AREA_SECURITY,
		'twofactor_totp' => self::AREA_SECURITY,
		'twofactor_webauthn' => self::AREA_SECURITY,
		'twofactor_nextcloud_notification' => self::AREA_SECURITY,
		'oauth2' => self::AREA_SECURITY,
	];

	/** @var array<string, list<string>>|null */
	private ?array $areas = null;

	public function __construct(
		private IAppManager $appManager,
	) {
	}

	public static function areaForApp(string $appId): string {
		return self::APP_AREA[$appId] ?? $appId;
	}

	#[\Override]
	public function getAreas(): array {
		if ($this->areas !== null) {
			return $this->areas;
		}
		$areas = self::CORE_AREAS + self::KNOWN_APPS;
		foreach ($this->appManager->getEnabledApps() as $appId) {
			$declared = $this->declaredScopes($appId);
			foreach ($declared as $area => $actions) {
				$areas[$area] = array_values(array_unique(array_merge($areas[$area] ?? [], $actions)));
			}
			$area = self::areaForApp($appId);
			if ($declared === [] && !isset($areas[$area])) {
				$areas[$area] = [self::R, self::W, self::D];
			}
		}
		ksort($areas);
		return $this->areas = $areas;
	}

	/**
	 * <scopes><scope area="mail" actions="read,write,send"/></scopes>
	 * @return array<string, list<string>>
	 */
	private function declaredScopes(string $appId): array {
		$info = $this->appManager->getAppInfo($appId);
		$entries = $info['scopes']['scope'] ?? [];
		if (isset($entries['@attributes'])) {
			$entries = [$entries];
		}
		$result = [];
		foreach ((array)$entries as $entry) {
			$attributes = is_array($entry) ? ($entry['@attributes'] ?? []) : [];
			$area = strtolower((string)($attributes['area'] ?? ''));
			if (!preg_match('/^[a-z0-9_]+$/', $area)) {
				continue;
			}
			$actions = array_filter(array_map(fn ($a) => strtolower(trim($a)), explode(',', (string)($attributes['actions'] ?? ''))),
				fn ($a) => preg_match('/^[a-z0-9_]+$/', $a) === 1);
			$result[$area] = array_values(array_unique(array_merge([self::R, self::W], $actions)));
		}
		return $result;
	}

	#[\Override]
	public function isValid(string $scope): bool {
		try {
			$scope = ScopeSet::normalize($scope);
		} catch (\InvalidArgumentException) {
			return false;
		}
		if ($scope === '*') {
			return true;
		}
		[$area, $action] = explode(':', $scope, 2);
		$areas = $this->getAreas();
		return isset($areas[$area]) && ($action === '*' || in_array($action, $areas[$area], true));
	}
}

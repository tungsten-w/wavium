<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Authentication\Scope;

use OCP\Authentication\Scope\IScopeRegistry;
use OCP\Authentication\Token\IToken;

/**
 * Scopes stored on a token, in the token's scope JSON next to the legacy keys:
 *
 *   {"filesystem": false, "atrium": {"v": 1, "scopes": ["mail:write"], "agent": true}}
 *
 * A token without the "atrium" key is a legacy token and is not scoped.
 *
 * Grammar: "*" (everything) | "<area>:*" (every action of an area) |
 * "<area>:<action>". "write" implies "read"; no other implication exists.
 * Agents are never allowed admin or security, whatever is stored, and
 * only hold explicit actions: "*" and "<area>:*" grant an agent nothing.
 */
final class ScopeSet {
	public const KEY = 'atrium';
	public const VERSION = 1;

	/** Areas an agent token can never use. */
	public const AGENT_FORBIDDEN = [IScopeRegistry::AREA_ADMIN, IScopeRegistry::AREA_SECURITY];

	/** @var array<string, true> */
	private array $scopes = [];

	/**
	 * @param list<string> $scopes
	 */
	public function __construct(
		array $scopes,
		private bool $agent = false,
	) {
		foreach ($scopes as $scope) {
			$this->scopes[self::normalize($scope)] = true;
		}
		ksort($this->scopes);
	}

	public static function normalize(string $scope): string {
		$scope = strtolower(trim($scope));
		if ($scope === '*') {
			return $scope;
		}
		if (!preg_match('/^[a-z0-9_]+:([a-z0-9_]+|\*)$/', $scope)) {
			throw new \InvalidArgumentException('Invalid scope "' . $scope . '", expected "<area>:<action>"');
		}
		return $scope;
	}

	/**
	 * Parses the token scope array. Returns null for legacy (unscoped) tokens.
	 */
	public static function fromTokenScope(array $tokenScope): ?self {
		$data = $tokenScope[self::KEY] ?? null;
		if (!is_array($data)) {
			return null;
		}
		$scopes = [];
		foreach ((array)($data['scopes'] ?? []) as $scope) {
			try {
				$scopes[] = self::normalize((string)$scope);
			} catch (\InvalidArgumentException) {
				// Unknown/invalid entries grant nothing.
			}
		}
		return new self($scopes, (bool)($data['agent'] ?? false));
	}

	/**
	 * The token scope array to store: legacy keys derived from the scopes so
	 * code that only knows "filesystem" keeps behaving correctly.
	 */
	public function toTokenScope(): array {
		return [
			IToken::SCOPE_FILESYSTEM => $this->allows('files', IScopeRegistry::ACTION_READ),
			self::KEY => [
				'v' => self::VERSION,
				'scopes' => $this->getScopes(),
				'agent' => $this->agent,
			],
		];
	}

	/**
	 * Token scope after a password-less login (OC_User::loginWithApache):
	 * adds skip-password-validation and keeps everything else of a scoped
	 * token; legacy tokens get the old {filesystem: true} as before.
	 */
	public static function withSkipPasswordValidation(array $tokenScope): array {
		if (self::fromTokenScope($tokenScope) === null) {
			$tokenScope = [IToken::SCOPE_FILESYSTEM => true];
		}
		$tokenScope[IToken::SCOPE_SKIP_PASSWORD_VALIDATION] = true;
		return $tokenScope;
	}

	/** @return list<string> */
	public function getScopes(): array {
		return array_keys($this->scopes);
	}

	public function isAgent(): bool {
		return $this->agent;
	}

	public function allows(string $area, string $action): bool {
		$area = strtolower($area);
		$action = strtolower($action);
		if ($this->agent && in_array($area, self::AGENT_FORBIDDEN, true)) {
			return false;
		}
		if ($this->agent) {
			// Agents only ever hold explicit actions; wildcards in a stored agent scope grant nothing.
			return ($area === 'core' && $action === IScopeRegistry::ACTION_READ)
				|| isset($this->scopes[$area . ':' . $action])
				|| ($action === IScopeRegistry::ACTION_READ && isset($this->scopes[$area . ':' . IScopeRegistry::ACTION_WRITE]));
		}
		if ($area === 'core' && $action === IScopeRegistry::ACTION_READ) {
			return true;
		}
		if (isset($this->scopes['*']) || isset($this->scopes[$area . ':*']) || isset($this->scopes[$area . ':' . $action])) {
			return true;
		}
		return $action === IScopeRegistry::ACTION_READ && isset($this->scopes[$area . ':' . IScopeRegistry::ACTION_WRITE]);
	}

	/**
	 * Whether every scope in $other is also allowed by this set (used so a
	 * scoped token can only create narrower tokens).
	 */
	public function covers(self $other): bool {
		if ($other->agent === false && $this->agent === true) {
			return false;
		}
		foreach ($other->getScopes() as $scope) {
			if ($scope === '*') {
				if (!isset($this->scopes['*'])) {
					return false;
				}
				continue;
			}
			[$area, $action] = explode(':', $scope, 2);
			if ($action === '*') {
				if (!isset($this->scopes['*']) && !isset($this->scopes[$area . ':*'])) {
					return false;
				}
				continue;
			}
			if (!$this->allows($area, $action)) {
				return false;
			}
		}
		return true;
	}
}

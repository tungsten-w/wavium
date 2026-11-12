<?php

/**
 * SPDX-FileCopyrightText: 2016 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OC\Lockdown;

use OCP\Authentication\Token\IToken;
use OCP\ISession;
use OCP\Lockdown\ILockdownManager;

class LockdownManager implements ILockdownManager {
	/** @var ISession */
	private $sessionCallback;

	private $enabled = false;

	/** @var array|null */
	private $scope;

	private ?string $tokenName = null;

	/**
	 * LockdownManager constructor.
	 *
	 * @param callable $sessionCallback we need to inject the session lazily to avoid dependency loops
	 */
	public function __construct(callable $sessionCallback) {
		$this->sessionCallback = $sessionCallback;
	}


	#[\Override]
	public function enable() {
		$this->enabled = true;
	}

	/**
	 * @return ISession
	 */
	private function getSession() {
		$callback = $this->sessionCallback;
		return $callback();
	}

	private function getScopeAsArray() {
		if (!$this->scope) {
			$session = $this->getSession();
			$sessionScope = $session->get('token_scope');
			if ($sessionScope) {
				$this->scope = $sessionScope;
			}
		}
		return $this->scope;
	}

	#[\Override]
	public function setToken(IToken $token) {
		$this->scope = $token->getScopeAsArray();
		try {
			$this->tokenName = $token->getName();
		} catch (\TypeError) {
			// Token without a name (only in tests); the name is informational.
			$this->tokenName = null;
		}
		$session = $this->getSession();
		$session->set('token_scope', $this->scope);
		$session->set('token_name', $this->tokenName);
		$this->enable();
	}

	/**
	 * Raw scope array of the token used for this request, null if none.
	 * Atrium: read by OC\Authentication\Scope\ScopeContext.
	 */
	public function getTokenScope(): ?array {
		return $this->getScopeAsArray() ?: null;
	}

	public function getTokenName(): ?string {
		if ($this->tokenName === null) {
			$name = $this->getSession()->get('token_name');
			$this->tokenName = is_string($name) ? $name : null;
		}
		return $this->tokenName;
	}

	#[\Override]
	public function canAccessFilesystem() {
		$scope = $this->getScopeAsArray();
		return !$scope || $scope[IToken::SCOPE_FILESYSTEM];
	}
}

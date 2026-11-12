<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Settings\Settings\Personal\Security;

use OC\Authentication\Token\INamedToken;
use OC\Authentication\Token\IProvider as IAuthTokenProvider;
use OC\Authentication\Token\IToken;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\Authentication\Scope\IScopeRegistry;
use OCP\Authentication\Exceptions\InvalidTokenException;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\ISession;
use OCP\IUserSession;
use OCP\Session\Exceptions\SessionNotAvailableException;
use OCP\Settings\ISettings;
use function array_map;

class Authtokens implements ISettings {

	public function __construct(
		private IAuthTokenProvider $tokenProvider,
		private ISession $session,
		private IUserSession $userSession,
		private IInitialState $initialState,
		private IConfig $serverConfig,
		private ?string $userId,
		private IScopeRegistry $scopeRegistry,
		private IGroupManager $groupManager,
	) {
	}

	/**
	 * Atrium: the same data as JSON (AuthSettingsController::index), for the React settings.
	 *
	 * @return array{app_tokens: list<array<string, mixed>>, can_create_app_token: bool, token_scope_areas: array<string, mixed>}
	 */
	public function getData(): array {
		return [
			'app_tokens' => array_values($this->getAppTokens()),
			'can_create_app_token' => $this->userSession->getImpersonatingUserID() === null
				&& $this->serverConfig->getSystemValueBool('auth_can_create_app_token', true),
			'token_scope_areas' => $this->getScopeAreas(),
		];
	}

	#[\Override]
	public function getForm(): TemplateResponse {
		foreach ($this->getData() as $key => $value) {
			$this->initialState->provideInitialState($key, $value);
		}
		return new TemplateResponse('settings', 'settings/personal/security/authtokens');
	}

	private function getScopeAreas(): array {
		// Atrium: areas and actions for scoped app passwords. "core" (read is
		// always granted) is left out; admin only for admins, the UI hides admin
		// and security for agent tokens.
		$areas = $this->scopeRegistry->getAreas();
		unset($areas['core']);
		if ($this->userId === null || !$this->groupManager->isAdmin($this->userId)) {
			unset($areas[IScopeRegistry::AREA_ADMIN]);
		}
		return $areas;
	}

	#[\Override]
	public function getSection(): string {
		return 'security';
	}

	#[\Override]
	public function getPriority(): int {
		return 100;
	}

	private function getAppTokens(): array {
		$tokens = $this->tokenProvider->getTokenByUser($this->userId);

		try {
			$sessionId = $this->session->getId();
		} catch (SessionNotAvailableException $ex) {
			return [];
		}
		try {
			$sessionToken = $this->tokenProvider->getToken($sessionId);
		} catch (InvalidTokenException $ex) {
			return [];
		}

		return array_map(function (IToken $token) use ($sessionToken) {
			$data = $token->jsonSerialize();
			$data['canDelete'] = true;
			$data['canRename'] = $token instanceof INamedToken && $data['type'] !== IToken::WIPE_TOKEN;
			if ($sessionToken->getId() === $token->getId()) {
				$data['canDelete'] = false;
				$data['canRename'] = false;
				$data['current'] = true;
			}
			return $data;
		}, $tokens);
	}
}

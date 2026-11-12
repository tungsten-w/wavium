<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OC\Core\Controller;

use OC\Agent\InternalAuth;
use OC\Authentication\Scope\ScopeGuard;
use OC\Authentication\Token\IProvider;
use OCP\Agent\IAgentManager;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\ApiRoute;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\OCSController;
use OCP\Authentication\Scope\IScopeContext;
use OCP\Authentication\Token\IToken;
use OCP\IRequest;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Security\ISecureRandom;

/**
 * The PHP half of the agent layer (ADR 0009). The layer itself runs in the Bun
 * server (server/agent/); PHP only answers "who is this?" and does the account
 * and token work that lives in PHP.
 *
 * - whoami: called by Bun with the caller's own Authorization/Cookie headers.
 * - internal/*: called only by Bun, guarded by X-Atrium-Internal (InternalAuth).
 *   Bun has already checked that the caller owns the agent.
 */
class AtriumAgentController extends OCSController {
	/** Agent tokens reach PHP routes with nothing more than this; the agent layer does all permission checks. */
	public const AGENT_TOKEN_SCOPES = ['account:read'];

	public function __construct(
		string $appName,
		IRequest $request,
		private IUserSession $userSession,
		private IUserManager $userManager,
		private IAgentManager $agentManager,
		private IScopeContext $scopeContext,
		private InternalAuth $internalAuth,
		private IProvider $tokenProvider,
		private ISecureRandom $random,
		private ScopeGuard $scopeGuard,
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * Who is calling (for the agent layer)
	 *
	 * @return DataResponse<Http::STATUS_OK, array{uid: string, displayName: string, isAgent: bool, agentToken: bool, owner: ?string}, array{}>|DataResponse<Http::STATUS_UNAUTHORIZED, array{}, array{}>
	 *
	 * 200: Caller returned
	 * 401: Not logged in
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'GET', url: '/atrium/agent/whoami', root: '/core')]
	public function whoami(): DataResponse {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$uid = $user->getUID();
		$agent = $this->agentManager->getAgent($uid);
		return new DataResponse([
			'uid' => $uid,
			'displayName' => $user->getDisplayName(),
			'isAgent' => $agent !== null,
			'agentToken' => $this->scopeContext->isAgent(),
			'owner' => $agent?->getOwnerUid(),
		]);
	}

	private function denied(): DataResponse {
		return new DataResponse(['message' => 'internal only'], Http::STATUS_FORBIDDEN);
	}

	private function agentRow(string $uid): ?array {
		$agent = $this->agentManager->getAgent($uid);
		$user = $this->userManager->get($uid);
		if ($agent === null || $user === null) {
			return null;
		}
		return [
			'uid' => $uid,
			'displayName' => $user->getDisplayName(),
			'description' => $agent->getDescription(),
			'owner' => $agent->getOwnerUid(),
			'createdAt' => $agent->getCreatedAt()->getTimestamp(),
			'enabled' => $user->isEnabled(),
		];
	}

	/**
	 * Agents owned by a user (internal)
	 *
	 * @return DataResponse<Http::STATUS_OK, array{agents: list<array<string, mixed>>}, array{}>|DataResponse<Http::STATUS_FORBIDDEN, array{message: string}, array{}>
	 *
	 * 200: Agents returned
	 * 403: Not an internal call
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'GET', url: '/atrium/agent/internal/agents', root: '/core')]
	public function internalList(string $owner = '', string $uid = ''): DataResponse {
		if (!$this->internalAuth->isInternal($this->request)) {
			return $this->denied();
		}
		$rows = [];
		if ($uid !== '') {
			$row = $this->agentRow($uid);
			if ($row !== null) {
				$rows[] = $row;
			}
		} else {
			foreach ($this->agentManager->getAgentsOwnedBy($owner) as $agent) {
				$row = $this->agentRow($agent->getUid());
				if ($row !== null) {
					$rows[] = $row;
				}
			}
		}
		return new DataResponse(['agents' => $rows]);
	}

	public static function slug(string $name): string {
		$slug = strtolower(trim((string)preg_replace('/[^A-Za-z0-9]+/', '-', $name), '-'));
		return substr($slug, 0, 40);
	}

	/**
	 * Create an agent account (internal)
	 *
	 * @return DataResponse<Http::STATUS_OK, array<string, mixed>, array{}>|DataResponse<Http::STATUS_BAD_REQUEST|Http::STATUS_FORBIDDEN|Http::STATUS_CONFLICT, array{message: string}, array{}>
	 *
	 * 200: Agent created
	 * 400: Bad name or owner
	 * 403: Not an internal call
	 * 409: An account with that name exists
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'POST', url: '/atrium/agent/internal/agents', root: '/core')]
	public function internalCreate(string $owner, string $name, string $description = ''): DataResponse {
		if (!$this->internalAuth->isInternal($this->request)) {
			return $this->denied();
		}
		$ownerUser = $this->userManager->get($owner);
		if ($ownerUser === null || $this->agentManager->isAgent($owner)) {
			return new DataResponse(['message' => 'Unknown owner'], Http::STATUS_BAD_REQUEST);
		}
		$slug = self::slug($name);
		if ($slug === '') {
			return new DataResponse(['message' => 'The name needs at least one letter or digit'], Http::STATUS_BAD_REQUEST);
		}
		$uid = 'agent-' . $slug;
		if ($this->userManager->userExists($uid)) {
			return new DataResponse(['message' => 'An account named ' . $uid . ' already exists'], Http::STATUS_CONFLICT);
		}
		// Nobody knows this password: agents never log in on the web, they use tokens.
		$password = $this->random->generate(64);
		$user = $this->userManager->createUser($uid, $password);
		if ($user === false) {
			return new DataResponse(['message' => 'Could not create the account'], Http::STATUS_BAD_REQUEST);
		}
		$user->setDisplayName(trim($name));
		$this->agentManager->registerAgent($uid, $owner, $description);
		return new DataResponse($this->agentRow($uid) ?? []);
	}

	/**
	 * Rename or describe an agent (internal)
	 *
	 * @return DataResponse<Http::STATUS_OK, array<string, mixed>, array{}>|DataResponse<Http::STATUS_FORBIDDEN|Http::STATUS_NOT_FOUND, array{message: string}, array{}>
	 *
	 * 200: Agent updated
	 * 403: Not an internal call
	 * 404: Unknown agent
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'PUT', url: '/atrium/agent/internal/agents/{uid}', root: '/core')]
	public function internalUpdate(string $uid, ?string $displayName = null, ?string $description = null): DataResponse {
		if (!$this->internalAuth->isInternal($this->request)) {
			return $this->denied();
		}
		$agent = $this->agentManager->getAgent($uid);
		$user = $this->userManager->get($uid);
		if ($agent === null || $user === null) {
			return new DataResponse(['message' => 'Unknown agent'], Http::STATUS_NOT_FOUND);
		}
		if ($displayName !== null && trim($displayName) !== '') {
			$user->setDisplayName(trim($displayName));
		}
		if ($description !== null) {
			\OCP\Server::get(\OC\Agent\AgentManager::class)->setDescription($uid, $description);
		}
		return new DataResponse($this->agentRow($uid) ?? []);
	}

	/**
	 * Delete an agent account (internal)
	 *
	 * @return DataResponse<Http::STATUS_OK, array{deleted: bool}, array{}>|DataResponse<Http::STATUS_FORBIDDEN|Http::STATUS_NOT_FOUND, array{message: string}, array{}>
	 *
	 * 200: Deleted
	 * 403: Not an internal call
	 * 404: Unknown agent
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'DELETE', url: '/atrium/agent/internal/agents/{uid}', root: '/core')]
	public function internalDelete(string $uid): DataResponse {
		if (!$this->internalAuth->isInternal($this->request)) {
			return $this->denied();
		}
		$user = $this->userManager->get($uid);
		if ($user === null || !$this->agentManager->isAgent($uid)) {
			return new DataResponse(['message' => 'Unknown agent'], Http::STATUS_NOT_FOUND);
		}
		// Deleting the user also unregisters it (UserDeletedListener) and drops its tokens.
		$user->delete();
		$this->agentManager->unregisterAgent($uid);
		return new DataResponse(['deleted' => true]);
	}

	/**
	 * Tokens of an agent (internal)
	 *
	 * @return DataResponse<Http::STATUS_OK, array{tokens: list<array{id: int, name: string, lastActivity: int, agent: bool}>}, array{}>|DataResponse<Http::STATUS_FORBIDDEN, array{message: string}, array{}>
	 *
	 * 200: Tokens returned
	 * 403: Not an internal call
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'GET', url: '/atrium/agent/internal/agents/{uid}/tokens', root: '/core')]
	public function internalTokens(string $uid): DataResponse {
		if (!$this->internalAuth->isInternal($this->request)) {
			return $this->denied();
		}
		$rows = [];
		foreach ($this->tokenProvider->getTokenByUser($uid) as $token) {
			if ($token->getType() !== IToken::PERMANENT_TOKEN) {
				continue;
			}
			$scope = $token->getScopeAsArray();
			$rows[] = [
				'id' => $token->getId(),
				'name' => $token->getName(),
				'lastActivity' => $token instanceof \OC\Authentication\Token\PublicKeyToken ? $token->getLastActivity() : 0,
				'agent' => (bool)($scope['atrium']['agent'] ?? false),
			];
		}
		return new DataResponse(['tokens' => $rows]);
	}

	/**
	 * Create an agent token (internal). The token is shown once.
	 *
	 * @param list<string> $scopes
	 * @return DataResponse<Http::STATUS_OK, array{id: int, name: string, token: string}, array{}>|DataResponse<Http::STATUS_BAD_REQUEST|Http::STATUS_FORBIDDEN|Http::STATUS_NOT_FOUND, array{message: string}, array{}>
	 *
	 * 200: Token created
	 * 400: Invalid scope
	 * 403: Not an internal call
	 * 404: Unknown agent
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'POST', url: '/atrium/agent/internal/agents/{uid}/tokens', root: '/core')]
	public function internalCreateToken(string $uid, string $name = 'agent', array $scopes = []): DataResponse {
		if (!$this->internalAuth->isInternal($this->request)) {
			return $this->denied();
		}
		if (!$this->agentManager->isAgent($uid) || !$this->userManager->userExists($uid)) {
			return new DataResponse(['message' => 'Unknown agent'], Http::STATUS_NOT_FOUND);
		}
		try {
			$scope = $this->scopeGuard->newTokenScope(self::tokenScopes($scopes), true);
		} catch (\InvalidArgumentException $e) {
			return new DataResponse(['message' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
		$secret = $this->random->generate(72, ISecureRandom::CHAR_UPPER . ISecureRandom::CHAR_LOWER . ISecureRandom::CHAR_DIGITS);
		$token = $this->tokenProvider->generateToken(
			$secret,
			$uid,
			$uid,
			null,
			trim($name) === '' ? 'agent' : trim($name),
			IToken::PERMANENT_TOKEN,
			IToken::DO_NOT_REMEMBER,
			$scope?->toTokenScope(),
		);
		return new DataResponse(['id' => $token->getId(), 'name' => $token->getName(), 'token' => $secret]);
	}

	/**
	 * Scope areas and their actions (internal), for the permission table
	 *
	 * @return DataResponse<Http::STATUS_OK, array{areas: array<string, list<string>>}, array{}>|DataResponse<Http::STATUS_FORBIDDEN, array{message: string}, array{}>
	 *
	 * 200: Areas returned
	 * 403: Not an internal call
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'GET', url: '/atrium/agent/internal/areas', root: '/core')]
	public function internalAreas(): DataResponse {
		if (!$this->internalAuth->isInternal($this->request)) {
			return $this->denied();
		}
		$areas = \OCP\Server::get(\OC\Authentication\Scope\ScopeRegistry::class)->getAreas();
		foreach (\OC\Authentication\Scope\ScopeSet::AGENT_FORBIDDEN as $forbidden) {
			unset($areas[$forbidden]);
		}
		return new DataResponse(['areas' => array_map('array_values', $areas)]);
	}

	/**
	 * Set the scopes of every agent token of an agent (internal). Called when its
	 * permissions change, so the token on DAV/OCS matches what is "allowed".
	 *
	 * @param list<string> $scopes
	 * @return DataResponse<Http::STATUS_OK, array{updated: int}, array{}>|DataResponse<Http::STATUS_BAD_REQUEST|Http::STATUS_FORBIDDEN, array{message: string}, array{}>
	 *
	 * 200: Tokens updated
	 * 400: Invalid scope
	 * 403: Not an internal call
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'PUT', url: '/atrium/agent/internal/agents/{uid}/scopes', root: '/core')]
	public function internalSetScopes(string $uid, array $scopes = []): DataResponse {
		if (!$this->internalAuth->isInternal($this->request)) {
			return $this->denied();
		}
		try {
			$set = $this->scopeGuard->newTokenScope(self::tokenScopes($scopes), true);
		} catch (\InvalidArgumentException $e) {
			return new DataResponse(['message' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		}
		$updated = 0;
		foreach ($this->tokenProvider->getTokenByUser($uid) as $token) {
			if ($token->getType() !== IToken::PERMANENT_TOKEN || !($token->getScopeAsArray()['atrium']['agent'] ?? false)) {
				continue;
			}
			$token->setScope($set?->toTokenScope());
			$this->tokenProvider->updateToken($token);
			$updated++;
		}
		return new DataResponse(['updated' => $updated]);
	}

	/**
	 * @param list<string> $scopes
	 * @return list<string>
	 */
	public static function tokenScopes(array $scopes): array {
		return array_values(array_unique([...self::AGENT_TOKEN_SCOPES, ...array_map('strval', $scopes)]));
	}

	/**
	 * Revoke an agent token (internal)
	 *
	 * @return DataResponse<Http::STATUS_OK, array{revoked: bool}, array{}>|DataResponse<Http::STATUS_FORBIDDEN, array{message: string}, array{}>
	 *
	 * 200: Revoked (or did not exist)
	 * 403: Not an internal call
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[ApiRoute(verb: 'DELETE', url: '/atrium/agent/internal/agents/{uid}/tokens/{id}', root: '/core')]
	public function internalRevokeToken(string $uid, int $id): DataResponse {
		if (!$this->internalAuth->isInternal($this->request)) {
			return $this->denied();
		}
		$this->tokenProvider->invalidateTokenById($uid, $id);
		return new DataResponse(['revoked' => true]);
	}
}

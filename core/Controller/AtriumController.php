<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OC\Core\Controller;

use OCP\Agent\IAgentGrantManager;
use OCP\Agent\IAgentManager;
use OCP\App\IAppManager;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\ApiRoute;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\PasswordConfirmationRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\OCSController;
use OCP\Authentication\TwoFactorAuth\IRegistry as ITwoFactorRegistry;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\IUserSession;
use OCP\Settings\IManager as ISettingsManager;

/**
 * What the React shell needs once per page load: who is logged in, which apps
 * are enabled for them, and the agents they own (Settings > Agents).
 */
class AtriumController extends OCSController {
	public function __construct(
		string $appName,
		IRequest $request,
		private IUserSession $userSession,
		private IAppManager $appManager,
		private IGroupManager $groupManager,
		private IAgentManager $agentManager,
		private IAgentGrantManager $grantManager,
		private ISettingsManager $settingsManager,
		private \OC\InitialStateService $initialState,
		private \Psr\Log\LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * Shell session info
	 *
	 * @return DataResponse<Http::STATUS_OK, array{user: array{id: string, displayName: string, email: ?string, isAdmin: bool, isAgent: bool}, enabledApps: list<string>, settings: array{personal: list<array{id: string, name: string, icon: string}>, admin: list<array{id: string, name: string, icon: string}>}, agents: list<array{uid: string, displayName: string, description: string, createdAt: int, grants: list<array{area: string, actions: list<string>, full: bool}>}>}, array{}>
	 *
	 * 200: Session returned
	 */
	#[NoAdminRequired]
	#[ApiRoute(verb: 'GET', url: '/atrium/session', root: '/core')]
	public function session(): DataResponse {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$uid = $user->getUID();
		$agents = [];
		foreach ($this->agentManager->getAgentsOwnedBy($uid) as $agent) {
			$grants = [];
			foreach ($this->grantManager->getGrantsFrom($uid, $agent->getUid()) as $grant) {
				$grants[] = ['area' => $grant->getArea(), 'actions' => array_values($grant->getActions()), 'full' => $grant->isFullAccess()];
			}
			$agents[] = [
				'uid' => $agent->getUid(),
				'displayName' => \OCP\Server::get(\OCP\IUserManager::class)->getDisplayName($agent->getUid()) ?? $agent->getUid(),
				'description' => $agent->getDescription(),
				'createdAt' => $agent->getCreatedAt()->getTimestamp(),
				'grants' => $grants,
			];
		}
		return new DataResponse([
			'user' => [
				'id' => $uid,
				'displayName' => $user->getDisplayName(),
				'email' => $user->getEMailAddress(),
				'isAdmin' => $this->groupManager->isAdmin($uid),
				'isAgent' => $this->agentManager->isAgent($uid),
			],
			'enabledApps' => array_values($this->appManager->getEnabledAppsForUser($user)),
			'agents' => $agents,
			'settings' => $this->settingsSections($user),
		]);
	}

	/**
	 * Settings section data as JSON
	 *
	 * Runs the forms of one settings section (the same permission checks as the
	 * classic page) and returns the initial state they provide, so React sections
	 * get the data PHP templates used to get, without a template.
	 *
	 * @param string $kind "personal" or "admin"
	 * @param string $section Section id
	 * @return DataResponse<Http::STATUS_OK, array<string, array<string, mixed>>, array{}>|DataResponse<Http::STATUS_FORBIDDEN|Http::STATUS_NOT_FOUND, list<empty>, array{}>
	 *
	 * 200: State by app id and key
	 * 403: Not allowed to see this section
	 * 404: No such section
	 */
	#[NoAdminRequired]
	#[ApiRoute(verb: 'GET', url: '/atrium/settings/{kind}/{section}', root: '/core', requirements: ['kind' => 'personal|admin'])]
	public function settingsState(string $kind, string $section): DataResponse {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse([], Http::STATUS_FORBIDDEN);
		}
		$byPriority = $kind === 'admin'
			? $this->settingsManager->getAllowedAdminSettings($section, $user)
			: $this->settingsManager->getPersonalSettings($section);
		if ($byPriority === []) {
			return new DataResponse([], $kind === 'admin' ? Http::STATUS_FORBIDDEN : Http::STATUS_NOT_FOUND);
		}
		$before = $this->initialState->getInitialStates();
		foreach ($byPriority as $settings) {
			foreach ($settings as $setting) {
				try {
					$setting->getForm();
				} catch (\Throwable $e) {
					$this->logger->warning('Settings form failed: ' . $setting::class, ['exception' => $e]);
				}
			}
		}
		$out = [];
		foreach ($this->initialState->getInitialStates() as $id => $json) {
			if (($before[$id] ?? null) === $json) {
				continue;
			}
			[$app, $key] = explode('-', $id, 2);
			$out[$app][$key] = json_decode($json, true);
		}
		return new DataResponse($out);
	}

	/**
	 * Two-factor providers of the current user: which exist, which are enabled, and the
	 * backup code counts (the classic page only gets these inside its own template).
	 *
	 * @return DataResponse<Http::STATUS_OK, array{enforced: bool, providers: list<array{id: string, name: string, description: string, enabled: bool}>, backupCodes: ?array{enabled: bool, total: int, used: int}}, array{}>|DataResponse<Http::STATUS_UNAUTHORIZED, list<empty>, array{}>
	 *
	 * 200: State returned
	 */
	#[NoAdminRequired]
	#[ApiRoute(verb: 'GET', url: '/atrium/twofactor', root: '/core')]
	public function twoFactor(): DataResponse {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$states = \OCP\Server::get(ITwoFactorRegistry::class)->getProviderStates($user);
		$providers = [];
		foreach (\OCP\Server::get(\OC\Authentication\TwoFactorAuth\ProviderLoader::class)->getProviders($user) as $provider) {
			$providers[] = [
				'id' => $provider->getId(),
				'name' => $provider->getDisplayName(),
				'description' => $provider->getDescription(),
				'enabled' => $states[$provider->getId()] ?? false,
			];
		}
		$backup = null;
		$storage = '\\OCA\\TwoFactorBackupCodes\\Service\\BackupCodeStorage';
		if (class_exists($storage) && $this->appManager->isEnabledForUser('twofactor_backupcodes', $user)) {
			$backup = \OCP\Server::get($storage)->getBackupCodesState($user);
		}
		return new DataResponse([
			'enforced' => \OCP\Server::get(\OC\Authentication\TwoFactorAuth\MandatoryTwoFactor::class)->isEnforcedFor($user),
			'providers' => $providers,
			'backupCodes' => $backup,
		]);
	}

	/**
	 * Turn one of your own two-factor providers off.
	 *
	 * @param string $provider Provider id
	 * @return DataResponse<Http::STATUS_OK, array<string, bool>, array{}>|DataResponse<Http::STATUS_UNAUTHORIZED, list<empty>, array{}>
	 *
	 * 200: New provider states
	 */
	#[NoAdminRequired]
	#[PasswordConfirmationRequired(strict: true)]
	#[ApiRoute(verb: 'POST', url: '/atrium/twofactor/disable', root: '/core')]
	public function twoFactorDisable(string $provider): DataResponse {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse([], Http::STATUS_UNAUTHORIZED);
		}
		\OCP\Server::get(\OC\Authentication\TwoFactorAuth\ProviderManager::class)->tryDisableProviderFor($provider, $user);
		return new DataResponse(\OCP\Server::get(ITwoFactorRegistry::class)->getProviderStates($user));
	}

	/**
	 * Classic settings sections the user can open (the shell lists them next to
	 * its own React sections and shows them in a frame).
	 *
	 * @return array{personal: list<array{id: string, name: string, icon: string}>, admin: list<array{id: string, name: string, icon: string}>}
	 */
	private function settingsSections(\OCP\IUser $user): array {
		$out = ['personal' => [], 'admin' => []];
		foreach ($this->settingsManager->getPersonalSections() as $sections) {
			foreach ($sections as $section) {
				if ($this->settingsManager->getPersonalSettings($section->getID()) !== []) {
					$out['personal'][] = ['id' => $section->getID(), 'name' => $section->getName(), 'icon' => (string)$section->getIcon()];
				}
			}
		}
		foreach ($this->settingsManager->getAdminSections() as $sections) {
			foreach ($sections as $section) {
				if ($this->settingsManager->getAllowedAdminSettings($section->getID(), $user) !== []) {
					$out['admin'][] = ['id' => $section->getID(), 'name' => $section->getName(), 'icon' => (string)$section->getIcon()];
				}
			}
		}
		return $out;
	}
}

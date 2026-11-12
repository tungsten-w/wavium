<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OC\Authentication\Login;

use OC\Core\Controller\LoginController;
use OCP\Agent\IAgentManager;
use Psr\Log\LoggerInterface;

/**
 * Atrium (ADR 0009): agent accounts never log in on the web. They use agent
 * tokens from Settings > Agents; a known password (an adopted account) does
 * not open a browser session.
 */
class AgentLoginBlockCommand extends ALoginCommand {
	public function __construct(
		private IAgentManager $agentManager,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function process(LoginData $loginData): LoginResult {
		$user = $loginData->getUser();
		if ($user !== false && $this->agentManager->isAgent($user->getUID())) {
			$this->logger->warning('Web login refused for agent account ' . $user->getUID());
			return LoginResult::failure(LoginController::LOGIN_MSG_INVALIDPASSWORD);
		}
		return $this->processNextOrFinishSuccessfully($loginData);
	}
}

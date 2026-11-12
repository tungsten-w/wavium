<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Agent\Listener;

use OC\Agent\AgentManager;
use OCP\Agent\IAgentGrantManager;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\User\Events\UserDeletedEvent;

/**
 * A deleted account loses its agent entry and every grant it made or received;
 * agents it owned are unregistered (their accounts stay).
 *
 * @template-implements IEventListener<UserDeletedEvent>
 */
class UserDeletedListener implements IEventListener {
	public function __construct(
		private AgentManager $agentManager,
		private IAgentGrantManager $grantManager,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!$event instanceof UserDeletedEvent) {
			return;
		}
		$uid = $event->getUid();
		$this->grantManager->revokeAllFromGrantor($uid);
		$this->agentManager->unregisterAgentsOwnedBy($uid);
		$this->agentManager->unregisterAgent($uid);
	}
}

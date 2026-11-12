<?php

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare(strict_types=1);

namespace Test\Authentication\Login;

use OC\Authentication\Login\AgentLoginBlockCommand;
use OC\Core\Controller\LoginController;
use OCP\Agent\IAgentManager;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class AgentLoginBlockCommandTest extends ALoginTestCommand {
	private IAgentManager&MockObject $agentManager;

	#[\Override]
	protected function setUp(): void {
		parent::setUp();
		$this->agentManager = $this->createMock(IAgentManager::class);
		$this->cmd = new AgentLoginBlockCommand($this->agentManager, $this->createMock(LoggerInterface::class));
	}

	public function testPersonLogsIn(): void {
		$this->user->method('getUID')->willReturn('alice');
		$this->agentManager->method('isAgent')->with('alice')->willReturn(false);
		$this->assertTrue($this->cmd->process($this->getLoggedInLoginData())->isSuccess());
	}

	public function testAgentIsRefused(): void {
		$this->user->method('getUID')->willReturn('lia');
		$this->agentManager->method('isAgent')->with('lia')->willReturn(true);
		$result = $this->cmd->process($this->getLoggedInLoginData());
		$this->assertFalse($result->isSuccess());
		$this->assertSame(LoginController::LOGIN_MSG_INVALIDPASSWORD, $result->getErrorMessage());
	}
}

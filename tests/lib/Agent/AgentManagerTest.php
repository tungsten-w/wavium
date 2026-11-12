<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Test\Agent;

use OC\Agent\AgentManager;
use OCP\Agent\IAgentGrant;
use OCP\Agent\IAgentGrantManager;
use OCP\Agent\IAgentManager;
use OCP\IUserManager;
use OCP\Server;
use Test\TestCase;

#[\PHPUnit\Framework\Attributes\Group('DB')]
class AgentManagerTest extends TestCase {
	private const OWNER = 'atrium-agent-owner';
	private const OTHER = 'atrium-agent-other';
	private const AGENT = 'atrium-agent-bot';
	private const AGENT2 = 'atrium-agent-bot2';

	private IAgentManager $agents;
	private IAgentGrantManager $grants;
	private IUserManager $users;

	#[\Override]
	protected function setUp(): void {
		parent::setUp();
		$this->users = Server::get(IUserManager::class);
		foreach ([self::OWNER, self::OTHER, self::AGENT, self::AGENT2] as $uid) {
			if (!$this->users->userExists($uid)) {
				$this->users->createUser($uid, 'Atrium-test-password-' . $uid);
			}
		}
		$this->agents = Server::get(IAgentManager::class);
		$this->grants = Server::get(IAgentGrantManager::class);
	}

	#[\Override]
	protected function tearDown(): void {
		foreach ([self::AGENT, self::AGENT2, self::OWNER, self::OTHER] as $uid) {
			$this->users->get($uid)?->delete();
		}
		parent::tearDown();
	}

	public function testRegisterAndRead(): void {
		$this->assertFalse($this->agents->isAgent(self::AGENT));
		$agent = $this->agents->registerAgent(self::AGENT, self::OWNER, '  Nova  ');
		$this->assertSame(self::AGENT, $agent->getUid());
		$this->assertSame(self::OWNER, $agent->getOwnerUid());
		$this->assertSame('Nova', $agent->getDescription());

		// A fresh manager reads it back from the database.
		$fresh = Server::get(AgentManager::class);
		$this->assertTrue($fresh->isAgent(self::AGENT));
		$this->assertSame(self::OWNER, $fresh->getAgent(self::AGENT)?->getOwnerUid());
		$this->assertSame([self::AGENT], array_map(fn ($a) => $a->getUid(), $fresh->getAgentsOwnedBy(self::OWNER)));
		$this->assertFalse($fresh->isAgent(self::OWNER));
	}

	public static function invalidRegistrations(): array {
		return [
			'self-owned' => [self::AGENT, self::AGENT],
			'missing agent account' => ['atrium-agent-missing', self::OWNER],
			'missing owner' => [self::AGENT, 'atrium-agent-missing'],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider('invalidRegistrations')]
	public function testRegisterRejects(string $uid, string $owner): void {
		$this->expectException(\InvalidArgumentException::class);
		$this->agents->registerAgent($uid, $owner);
	}

	public function testRegisterTwiceRejected(): void {
		$this->agents->registerAgent(self::AGENT, self::OWNER);
		$this->expectException(\InvalidArgumentException::class);
		$this->agents->registerAgent(self::AGENT, self::OTHER);
	}

	public function testAgentCannotOwnAgents(): void {
		$this->agents->registerAgent(self::AGENT, self::OWNER);
		$this->expectException(\InvalidArgumentException::class);
		$this->agents->registerAgent(self::AGENT2, self::AGENT);
	}

	public function testGrants(): void {
		$this->agents->registerAgent(self::AGENT, self::OWNER);

		$grant = $this->grants->setGrant(self::OWNER, self::AGENT, 'Contacts', ['write', 'READ', 'write', 'bad action', '*']);
		$this->assertSame('contacts', $grant->getArea());
		$this->assertSame(['read', 'write'], $grant->getActions());
		$this->assertTrue($grant->allows('read'));
		$this->assertFalse($grant->allows('delete'));

		// Replacing keeps one row per (agent, grantor, area).
		$this->grants->setGrant(self::OWNER, self::AGENT, 'contacts', ['write']);
		$this->grants->setGrant(self::OTHER, self::AGENT, 'calendar', ['read']);
		$this->grants->setGrant(self::OWNER, self::AGENT, IAgentGrant::AREA_ALL, ['ignored']);

		$stored = $this->grants->getGrant(self::OWNER, self::AGENT, 'contacts');
		$this->assertSame(['write'], $stored?->getActions());
		$this->assertTrue($stored?->allows('read'), 'write implies read');
		$full = $this->grants->getGrant(self::OWNER, self::AGENT, IAgentGrant::AREA_ALL);
		$this->assertTrue($full?->isFullAccess());
		$this->assertSame([], $full?->getActions());
		$this->assertCount(2, $this->grants->getGrantsFrom(self::OWNER, self::AGENT));
		$this->assertCount(3, $this->grants->getGrantsForAgent(self::AGENT));

		$this->grants->revokeGrant(self::OWNER, self::AGENT, 'CONTACTS');
		$this->assertNull($this->grants->getGrant(self::OWNER, self::AGENT, 'contacts'));
		$this->grants->revokeAllFromGrantor(self::OTHER);
		$this->assertCount(1, $this->grants->getGrantsForAgent(self::AGENT));
	}

	public static function invalidGrants(): array {
		return [
			'admin area' => [self::OWNER, self::AGENT, 'admin', ['read']],
			'security area' => [self::OWNER, self::AGENT, 'security', ['write']],
			'malformed area' => [self::OWNER, self::AGENT, 'con tacts', ['read']],
			'no valid action' => [self::OWNER, self::AGENT, 'contacts', ['*', '']],
			'not an agent' => [self::OWNER, self::OTHER, 'contacts', ['read']],
			'self grant' => [self::AGENT, self::AGENT, 'contacts', ['read']],
		];
	}

	#[\PHPUnit\Framework\Attributes\DataProvider('invalidGrants')]
	public function testGrantRejects(string $grantor, string $agent, string $area, array $actions): void {
		$this->agents->registerAgent(self::AGENT, self::OWNER);
		$this->expectException(\InvalidArgumentException::class);
		$this->grants->setGrant($grantor, $agent, $area, $actions);
	}

	public function testAgentCannotGrant(): void {
		$this->agents->registerAgent(self::AGENT, self::OWNER);
		$this->agents->registerAgent(self::AGENT2, self::OWNER);
		$this->expectException(\InvalidArgumentException::class);
		$this->grants->setGrant(self::AGENT2, self::AGENT, 'contacts', ['read']);
	}

	public function testUnregisterDropsGrants(): void {
		$this->agents->registerAgent(self::AGENT, self::OWNER);
		$this->grants->setGrant(self::OWNER, self::AGENT, 'contacts', ['read']);
		$this->agents->unregisterAgent(self::AGENT);
		$this->assertFalse($this->agents->isAgent(self::AGENT));
		$this->assertSame([], $this->grants->getGrantsForAgent(self::AGENT));
		$this->assertTrue($this->users->userExists(self::AGENT), 'the account stays');
	}

	public function testDeletingAccountsCleansUp(): void {
		$this->agents->registerAgent(self::AGENT, self::OWNER);
		$this->agents->registerAgent(self::AGENT2, self::OTHER);
		$this->grants->setGrant(self::OWNER, self::AGENT, 'contacts', ['read']);
		$this->grants->setGrant(self::OWNER, self::AGENT2, 'calendar', ['read']);

		// Deleting the owner unregisters its agents and drops its grants.
		$this->users->get(self::OWNER)->delete();
		$fresh = Server::get(AgentManager::class);
		$this->assertFalse($fresh->isAgent(self::AGENT));
		$this->assertSame([], $this->grants->getGrantsForAgent(self::AGENT2));
		$this->assertTrue($fresh->isAgent(self::AGENT2));

		// Deleting the agent account removes its entry.
		$this->users->get(self::AGENT2)->delete();
		$this->assertFalse(Server::get(AgentManager::class)->isAgent(self::AGENT2));
	}
}

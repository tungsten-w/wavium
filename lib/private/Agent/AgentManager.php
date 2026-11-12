<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Agent;

use OCP\Agent\IAgent;
use OCP\Agent\IAgentGrantManager;
use OCP\Agent\IAgentManager;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use OCP\IUserManager;
use Psr\Container\ContainerInterface;

class AgentManager implements IAgentManager {
	public const TABLE = 'atrium_agents';

	/** @var array<string, ?IAgent> */
	private array $cache = [];

	public function __construct(
		private IDBConnection $db,
		private IUserManager $userManager,
		private ITimeFactory $timeFactory,
		// The grant manager needs this manager too; resolve it lazily.
		private ContainerInterface $container,
	) {
	}

	#[\Override]
	public function isAgent(string $uid): bool {
		return $this->getAgent($uid) !== null;
	}

	#[\Override]
	public function getAgent(string $uid): ?IAgent {
		if (array_key_exists($uid, $this->cache)) {
			return $this->cache[$uid];
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from(self::TABLE)
			->where($qb->expr()->eq('uid', $qb->createNamedParameter($uid)));
		$result = $qb->executeQuery();
		$row = $result->fetch();
		$result->closeCursor();
		return $this->cache[$uid] = ($row === false ? null : $this->fromRow($row));
	}

	#[\Override]
	public function getAgentsOwnedBy(string $ownerUid): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from(self::TABLE)
			->where($qb->expr()->eq('owner_uid', $qb->createNamedParameter($ownerUid)))
			->orderBy('uid');
		$result = $qb->executeQuery();
		$agents = [];
		while ($row = $result->fetch()) {
			$agents[] = $this->cache[$row['uid']] = $this->fromRow($row);
		}
		$result->closeCursor();
		return $agents;
	}

	#[\Override]
	public function registerAgent(string $uid, string $ownerUid, string $description = ''): IAgent {
		if ($uid === $ownerUid) {
			throw new \InvalidArgumentException('An agent cannot own itself');
		}
		if (!$this->userManager->userExists($uid)) {
			throw new \InvalidArgumentException('Agent account does not exist');
		}
		if (!$this->userManager->userExists($ownerUid)) {
			throw new \InvalidArgumentException('Owner account does not exist');
		}
		if ($this->isAgent($uid)) {
			throw new \InvalidArgumentException('Account is already an agent');
		}
		if ($this->isAgent($ownerUid)) {
			throw new \InvalidArgumentException('An agent cannot own agents');
		}
		$description = mb_substr(trim($description), 0, 500);
		$now = $this->timeFactory->now();
		$qb = $this->db->getQueryBuilder();
		$qb->insert(self::TABLE)
			->values([
				'uid' => $qb->createNamedParameter($uid),
				'owner_uid' => $qb->createNamedParameter($ownerUid),
				'description' => $qb->createNamedParameter($description),
				'created_at' => $qb->createNamedParameter($now->getTimestamp(), IQueryBuilder::PARAM_INT),
			])
			->executeStatement();
		return $this->cache[$uid] = new Agent($uid, $ownerUid, $description, $now);
	}

	#[\Override]
	public function unregisterAgent(string $uid): void {
		$this->container->get(IAgentGrantManager::class)->revokeAllForAgent($uid);
		$qb = $this->db->getQueryBuilder();
		$qb->delete(self::TABLE)
			->where($qb->expr()->eq('uid', $qb->createNamedParameter($uid)))
			->executeStatement();
		$this->cache[$uid] = null;
	}

	/**
	 * Atrium: change an agent's description (Settings > Agents).
	 */
	public function setDescription(string $uid, string $description): void {
		$description = mb_substr(trim($description), 0, 500);
		$qb = $this->db->getQueryBuilder();
		$qb->update(self::TABLE)
			->set('description', $qb->createNamedParameter($description))
			->where($qb->expr()->eq('uid', $qb->createNamedParameter($uid)))
			->executeStatement();
		unset($this->cache[$uid]);
	}

	/**
	 * Unregister every agent owned by $ownerUid (the accounts stay).
	 */
	public function unregisterAgentsOwnedBy(string $ownerUid): void {
		foreach ($this->getAgentsOwnedBy($ownerUid) as $agent) {
			$this->unregisterAgent($agent->getUid());
		}
	}

	private function fromRow(array $row): IAgent {
		return new Agent(
			(string)$row['uid'],
			(string)$row['owner_uid'],
			(string)$row['description'],
			(new \DateTimeImmutable())->setTimestamp((int)$row['created_at']),
		);
	}
}

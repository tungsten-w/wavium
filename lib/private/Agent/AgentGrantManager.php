<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Agent;

use OCP\Agent\IAgentGrant;
use OCP\Agent\IAgentGrantManager;
use OCP\Agent\IAgentManager;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Authentication\Scope\IScopeRegistry;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

class AgentGrantManager implements IAgentGrantManager {
	public const TABLE = 'atrium_agent_grants';

	/** Areas no agent can ever be granted. */
	public const FORBIDDEN_AREAS = [IScopeRegistry::AREA_ADMIN, IScopeRegistry::AREA_SECURITY];

	private const NAME = '/^[a-z0-9_]{1,64}$/';

	public function __construct(
		private IDBConnection $db,
		private IAgentManager $agentManager,
		private ITimeFactory $timeFactory,
	) {
	}

	#[\Override]
	public function getGrantsForAgent(string $agentUid): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from(self::TABLE)
			->where($qb->expr()->eq('agent_uid', $qb->createNamedParameter($agentUid)))
			->orderBy('grantor_uid')
			->addOrderBy('area');
		return $this->fetchAll($qb);
	}

	#[\Override]
	public function getGrantsFrom(string $grantorUid, string $agentUid): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from(self::TABLE)
			->where($qb->expr()->eq('agent_uid', $qb->createNamedParameter($agentUid)))
			->andWhere($qb->expr()->eq('grantor_uid', $qb->createNamedParameter($grantorUid)))
			->orderBy('area');
		return $this->fetchAll($qb);
	}

	#[\Override]
	public function getGrant(string $grantorUid, string $agentUid, string $area): ?IAgentGrant {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from(self::TABLE)
			->where($qb->expr()->eq('agent_uid', $qb->createNamedParameter($agentUid)))
			->andWhere($qb->expr()->eq('grantor_uid', $qb->createNamedParameter($grantorUid)))
			->andWhere($qb->expr()->eq('area', $qb->createNamedParameter($area)));
		return $this->fetchAll($qb)[0] ?? null;
	}

	#[\Override]
	public function setGrant(string $grantorUid, string $agentUid, string $area, array $actions): IAgentGrant {
		if (!$this->agentManager->isAgent($agentUid)) {
			throw new \InvalidArgumentException('Not an agent');
		}
		if ($grantorUid === $agentUid) {
			throw new \InvalidArgumentException('An agent cannot grant itself access');
		}
		if ($this->agentManager->isAgent($grantorUid)) {
			throw new \InvalidArgumentException('Agents cannot grant access');
		}
		$area = strtolower($area);
		if ($area !== IAgentGrant::AREA_ALL && preg_match(self::NAME, $area) !== 1) {
			throw new \InvalidArgumentException('Invalid area');
		}
		if (in_array($area, self::FORBIDDEN_AREAS, true)) {
			throw new \InvalidArgumentException('Agents cannot be granted the ' . $area . ' area');
		}
		$actions = $area === IAgentGrant::AREA_ALL ? [] : self::normalizeActions($actions);
		if ($area !== IAgentGrant::AREA_ALL && $actions === []) {
			throw new \InvalidArgumentException('No valid action given');
		}

		$now = $this->timeFactory->now();
		$this->db->beginTransaction();
		try {
			$this->delete($grantorUid, $agentUid, $area);
			$qb = $this->db->getQueryBuilder();
			$qb->insert(self::TABLE)
				->values([
					'agent_uid' => $qb->createNamedParameter($agentUid),
					'grantor_uid' => $qb->createNamedParameter($grantorUid),
					'area' => $qb->createNamedParameter($area),
					'actions' => $qb->createNamedParameter(implode(',', $actions)),
					'created_at' => $qb->createNamedParameter($now->getTimestamp(), IQueryBuilder::PARAM_INT),
				])
				->executeStatement();
			$this->db->commit();
		} catch (\Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
		return new AgentGrant($agentUid, $grantorUid, $area, $actions, $now);
	}

	#[\Override]
	public function revokeGrant(string $grantorUid, string $agentUid, string $area): void {
		$this->delete($grantorUid, $agentUid, strtolower($area));
	}

	#[\Override]
	public function revokeAllForAgent(string $agentUid): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete(self::TABLE)
			->where($qb->expr()->eq('agent_uid', $qb->createNamedParameter($agentUid)))
			->executeStatement();
	}

	#[\Override]
	public function revokeAllFromGrantor(string $grantorUid): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete(self::TABLE)
			->where($qb->expr()->eq('grantor_uid', $qb->createNamedParameter($grantorUid)))
			->executeStatement();
	}

	/**
	 * Lowercase, drop malformed and wildcard actions, dedupe, sort.
	 *
	 * @param array<mixed> $actions
	 * @return list<string>
	 */
	public static function normalizeActions(array $actions): array {
		$clean = [];
		foreach ($actions as $action) {
			if (!is_string($action)) {
				continue;
			}
			$action = strtolower(trim($action));
			if (preg_match(self::NAME, $action) === 1) {
				$clean[$action] = true;
			}
		}
		$clean = array_keys($clean);
		sort($clean);
		return $clean;
	}

	private function delete(string $grantorUid, string $agentUid, string $area): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete(self::TABLE)
			->where($qb->expr()->eq('agent_uid', $qb->createNamedParameter($agentUid)))
			->andWhere($qb->expr()->eq('grantor_uid', $qb->createNamedParameter($grantorUid)))
			->andWhere($qb->expr()->eq('area', $qb->createNamedParameter($area)))
			->executeStatement();
	}

	/**
	 * @return list<IAgentGrant>
	 */
	private function fetchAll(IQueryBuilder $qb): array {
		$result = $qb->executeQuery();
		$grants = [];
		while ($row = $result->fetch()) {
			$actions = (string)$row['actions'] === '' ? [] : explode(',', (string)$row['actions']);
			$grants[] = new AgentGrant(
				(string)$row['agent_uid'],
				(string)$row['grantor_uid'],
				(string)$row['area'],
				$actions,
				(new \DateTimeImmutable())->setTimestamp((int)$row['created_at']),
			);
		}
		$result->closeCursor();
		return $grants;
	}
}

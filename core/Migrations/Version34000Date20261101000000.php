<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OC\Core\Migrations;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\Attributes\AddIndex;
use OCP\Migration\Attributes\CreateTable;
use OCP\Migration\Attributes\IndexType;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;
use Override;

/**
 * Atrium agent layer: which accounts are agents, and what users granted them.
 * See docs/architecture/0003-agent-principal.md and 0004-agent-grants.md.
 */
#[CreateTable(
	table: 'atrium_agents',
	columns: ['uid', 'owner_uid', 'description', 'created_at'],
	description: 'User accounts that are agents, and their owner',
)]
#[AddIndex(table: 'atrium_agents', type: IndexType::PRIMARY)]
#[AddIndex(table: 'atrium_agents', type: IndexType::INDEX, description: 'Agents of one owner')]
#[CreateTable(
	table: 'atrium_agent_grants',
	columns: ['id', 'agent_uid', 'grantor_uid', 'area', 'actions', 'created_at'],
	description: 'What each user lets each agent do with their data, per scope area',
)]
#[AddIndex(table: 'atrium_agent_grants', type: IndexType::PRIMARY)]
#[AddIndex(table: 'atrium_agent_grants', type: IndexType::UNIQUE, description: 'One grant per agent, grantor and area')]
#[AddIndex(table: 'atrium_agent_grants', type: IndexType::INDEX, description: 'Grants made by one user')]
class Version34000Date20261101000000 extends SimpleMigrationStep {
	#[Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		$changed = false;

		if (!$schema->hasTable('atrium_agents')) {
			$table = $schema->createTable('atrium_agents');
			$table->addColumn('uid', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('owner_uid', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('description', Types::STRING, ['notnull' => false, 'length' => 500, 'default' => '']);
			$table->addColumn('created_at', Types::BIGINT, ['notnull' => true, 'unsigned' => true, 'default' => 0]);
			$table->setPrimaryKey(['uid']);
			$table->addIndex(['owner_uid'], 'atrium_agents_owner');
			$changed = true;
		}

		if (!$schema->hasTable('atrium_agent_grants')) {
			$table = $schema->createTable('atrium_agent_grants');
			$table->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$table->addColumn('agent_uid', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('grantor_uid', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('area', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('actions', Types::STRING, ['notnull' => false, 'length' => 255, 'default' => '']);
			$table->addColumn('created_at', Types::BIGINT, ['notnull' => true, 'unsigned' => true, 'default' => 0]);
			$table->setPrimaryKey(['id']);
			$table->addUniqueIndex(['agent_uid', 'grantor_uid', 'area'], 'atrium_agent_grants_uniq');
			$table->addIndex(['grantor_uid'], 'atrium_agent_grants_grantor');
			$changed = true;
		}

		return $changed ? $schema : null;
	}
}

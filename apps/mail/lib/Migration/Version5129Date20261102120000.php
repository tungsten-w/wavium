<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;
use Override;

/**
 * Atrium's DB first for writes: a flag change is saved in Atrium at once; when the
 * mail server cannot be reached the change waits here and PendingOpsJob retries it.
 */
class Version5129Date20261102120000 extends SimpleMigrationStep {
	#[Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if ($schema->hasTable('mail_pending_ops')) {
			return null;
		}
		$t = $schema->createTable('mail_pending_ops');
		$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'length' => 20]);
		$t->addColumn('account_id', Types::INTEGER, ['notnull' => true]);
		$t->addColumn('mailbox_id', Types::BIGINT, ['notnull' => true, 'length' => 20]);
		$t->addColumn('uid', Types::BIGINT, ['notnull' => true, 'length' => 20]);
		// flag (more kinds later)
		$t->addColumn('op', Types::STRING, ['notnull' => true, 'length' => 16]);
		$t->addColumn('flag', Types::STRING, ['notnull' => true, 'length' => 64]);
		$t->addColumn('value', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
		// pending | failed
		$t->addColumn('status', Types::STRING, ['notnull' => true, 'length' => 16, 'default' => 'pending']);
		$t->addColumn('attempts', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
		$t->addColumn('last_error', Types::STRING, ['notnull' => false, 'length' => 512]);
		$t->addColumn('next_try', Types::INTEGER, ['notnull' => true, 'default' => 0]);
		$t->addColumn('created_at', Types::INTEGER, ['notnull' => true]);
		$t->setPrimaryKey(['id']);
		$t->addIndex(['status', 'next_try'], 'mail_pend_ops_due_idx');
		$t->addIndex(['mailbox_id', 'uid'], 'mail_pend_ops_msg_idx');
		return $schema;
	}
}

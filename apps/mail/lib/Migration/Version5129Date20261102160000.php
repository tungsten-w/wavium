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
 * Bookkeeping for ReaderBackfillJob (fills mail_bodies.reader_body for mail stored before the
 * reader copy existed). A mail that cannot be loaded is retried a few times, then marked
 * unavailable so it never costs a mail server login again.
 */
class Version5129Date20261102160000 extends SimpleMigrationStep {
	#[Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if ($schema->hasTable('mail_reader_backfill')) {
			return null;
		}
		$t = $schema->createTable('mail_reader_backfill');
		$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'length' => 20]);
		$t->addColumn('account_id', Types::INTEGER, ['notnull' => true]);
		$t->addColumn('msg_hash', Types::STRING, ['notnull' => true, 'length' => 32]);
		// retry | unavailable
		$t->addColumn('status', Types::STRING, ['notnull' => true, 'length' => 16, 'default' => 'retry']);
		$t->addColumn('attempts', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
		$t->addColumn('last_error', Types::STRING, ['notnull' => false, 'length' => 512]);
		$t->addColumn('next_try', Types::INTEGER, ['notnull' => true, 'default' => 0]);
		$t->addColumn('updated_at', Types::INTEGER, ['notnull' => true]);
		$t->setPrimaryKey(['id']);
		$t->addUniqueIndex(['account_id', 'msg_hash'], 'mail_rb_msg_uidx');
		return $schema;
	}
}

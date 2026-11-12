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
 * Atrium keeps the readable text of every mail it has fetched: headers and
 * plain-text body. Never attachments, never images. Keyed like the triage
 * tables (account + Message-ID hash), so it survives moves and archiving.
 */
class Version5128Date20261101120000 extends SimpleMigrationStep {
	#[Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if (!$schema->hasTable('mail_bodies')) {
			$t = $schema->createTable('mail_bodies');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'length' => 20]);
			$t->addColumn('account_id', Types::INTEGER, ['notnull' => true]);
			$t->addColumn('msg_hash', Types::STRING, ['notnull' => true, 'length' => 32]);
			// "From: ...\nTo: ...\nSubject: ..." block, one header per line.
			$t->addColumn('headers', Types::TEXT, ['notnull' => true]);
			$t->addColumn('body', Types::TEXT, ['notnull' => true]);
			$t->addColumn('attachments', Types::TEXT, ['notnull' => false]);
			$t->addColumn('has_unsubscribe', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
			$t->addColumn('sent_at', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			$t->addColumn('fetched_at', Types::INTEGER, ['notnull' => true]);
			$t->setPrimaryKey(['id']);
			$t->addUniqueIndex(['account_id', 'msg_hash'], 'mail_bodies_msg_uidx');
		}
		return $schema;
	}
}

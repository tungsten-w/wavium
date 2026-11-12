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
 * Attachments are kept only once someone (a user or the agent) has downloaded them,
 * never in bulk. Keyed like mail_bodies: account + Message-ID hash, so the copy follows
 * the mail across folders and survives the mail leaving the server.
 */
class Version5129Date20261102150000 extends SimpleMigrationStep {
	#[Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if ($schema->hasTable('mail_stored_attachments')) {
			return null;
		}
		$t = $schema->createTable('mail_stored_attachments');
		$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'length' => 20]);
		$t->addColumn('account_id', Types::INTEGER, ['notnull' => true]);
		$t->addColumn('msg_hash', Types::STRING, ['notnull' => true, 'length' => 32]);
		$t->addColumn('part_id', Types::STRING, ['notnull' => true, 'length' => 64]);
		$t->addColumn('name', Types::STRING, ['notnull' => false, 'length' => 255]);
		$t->addColumn('mime', Types::STRING, ['notnull' => true, 'length' => 255, 'default' => 'application/octet-stream']);
		$t->addColumn('size', Types::BIGINT, ['notnull' => true, 'default' => 0, 'length' => 20]);
		$t->addColumn('content', Types::BLOB, ['notnull' => false]);
		$t->addColumn('fetched_at', Types::INTEGER, ['notnull' => true]);
		$t->setPrimaryKey(['id']);
		$t->addUniqueIndex(['account_id', 'msg_hash', 'part_id'], 'mail_stored_att_part_uidx');
		return $schema;
	}
}

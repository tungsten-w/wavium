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
 * Atrium triage: mail classification through the decisions API.
 *
 * A mail is identified per account by a hash of its Message-ID, so the same
 * mail in INBOX and All Mail (or re-imported after a resync) is classified
 * once. Queue rows are never deleted: their status says where each mail is.
 */
class Version5127Date20261101000000 extends SimpleMigrationStep {
	#[Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('mail_triage_queue')) {
			$t = $schema->createTable('mail_triage_queue');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'length' => 20]);
			$t->addColumn('account_id', Types::INTEGER, ['notnull' => true]);
			$t->addColumn('msg_hash', Types::STRING, ['notnull' => true, 'length' => 32]);
			// Last known mail_messages.id of this mail (it changes on resync).
			$t->addColumn('db_id', Types::BIGINT, ['notnull' => true, 'length' => 20]);
			// 1 = new mail (recent, or arrived after the first enqueue), 0 = backlog.
			$t->addColumn('priority', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('sent_at', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			// pending | done | parked
			$t->addColumn('status', Types::STRING, ['notnull' => true, 'length' => 16, 'default' => 'pending']);
			$t->addColumn('attempts', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('last_error', Types::STRING, ['notnull' => false, 'length' => 512]);
			$t->addColumn('enqueued_at', Types::INTEGER, ['notnull' => true]);
			$t->addColumn('updated_at', Types::INTEGER, ['notnull' => true]);
			$t->setPrimaryKey(['id']);
			$t->addUniqueIndex(['account_id', 'msg_hash'], 'mail_triage_q_msg_uidx');
			$t->addIndex(['status', 'priority', 'sent_at'], 'mail_triage_q_next_idx');
			$t->addIndex(['db_id'], 'mail_triage_q_db_idx');
		}

		if (!$schema->hasTable('mail_triage')) {
			$t = $schema->createTable('mail_triage');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'length' => 20]);
			$t->addColumn('account_id', Types::INTEGER, ['notnull' => true]);
			$t->addColumn('msg_hash', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->addColumn('version', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->addColumn('model', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('category', Types::STRING, ['notnull' => false, 'length' => 32]);
			$t->addColumn('category_confidence', Types::FLOAT, ['notnull' => false]);
			$t->addColumn('urgency', Types::STRING, ['notnull' => false, 'length' => 32]);
			$t->addColumn('urgency_score', Types::FLOAT, ['notnull' => false]);
			$t->addColumn('needs_reply', Types::FLOAT, ['notnull' => false]);
			$t->addColumn('needs_action', Types::FLOAT, ['notnull' => false]);
			$t->addColumn('has_deadline', Types::FLOAT, ['notnull' => false]);
			$t->addColumn('written_by_person', Types::FLOAT, ['notnull' => false]);
			$t->addColumn('suspicious', Types::FLOAT, ['notnull' => false]);
			// Full decisions API response, kept so new fields never need a re-run.
			$t->addColumn('raw', Types::TEXT, ['notnull' => false]);
			$t->addColumn('input_tokens', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			$t->addColumn('cost_eur', Types::FLOAT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('backfill', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
			$t->addColumn('classified_at', Types::INTEGER, ['notnull' => true]);
			$t->setPrimaryKey(['id']);
			$t->addUniqueIndex(['account_id', 'msg_hash'], 'mail_triage_msg_uidx');
			$t->addIndex(['classified_at'], 'mail_triage_at_idx');
		}

		return $schema;
	}
}

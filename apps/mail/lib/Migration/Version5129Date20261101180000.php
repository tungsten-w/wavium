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
 * Atrium's own copy is the source of truth: a mail that disappears from the
 * mail server stays in Atrium. Its mail_messages row is kept and marked with
 * server_gone_at (unix time it was last seen gone); its uid becomes -id so it
 * can never collide with a server UID or be sent to the server.
 *
 * The message_id index makes the "is there another copy of this Message-ID in
 * the account" checks of the sync cheap (moved vs vanished, coming back).
 */
class Version5129Date20261101180000 extends SimpleMigrationStep {
	#[Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		$t = $schema->getTable('mail_messages');
		$changed = false;
		if (!$t->hasColumn('server_gone_at')) {
			$t->addColumn('server_gone_at', Types::INTEGER, ['notnull' => false, 'default' => null]);
			$changed = true;
		}
		// Same index as upstream's optional mail_messages_msgid_idx (occ db:add-missing-indices).
		if (!$t->hasIndex('mail_messages_msgid_idx')) {
			$t->addIndex(['message_id'], 'mail_messages_msgid_idx', [], ['lengths' => [128]]);
			$changed = true;
		}
		return $changed ? $schema : null;
	}
}

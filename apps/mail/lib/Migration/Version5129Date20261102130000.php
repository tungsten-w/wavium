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

/** Queued moves (and deletes to Trash) need the target folder; a move has no flag. */
class Version5129Date20261102130000 extends SimpleMigrationStep {
	#[Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		$t = $schema->getTable('mail_pending_ops');
		if ($t->hasColumn('target_mailbox_id')) {
			return null;
		}
		$t->addColumn('target_mailbox_id', Types::BIGINT, ['notnull' => false, 'length' => 20]);
		$t->changeColumn('flag', ['default' => '']);
		return $schema;
	}
}

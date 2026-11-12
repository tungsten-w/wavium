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
 * Atrium's DB first: the reader opens mail from Atrium's copy and asks the mail
 * server only for mail it never stored. mail_bodies keeps what the reader shows:
 * the sanitized body (remote images stay blocked, never attachments) and its
 * header data as JSON (reply-to, attachment names, unsubscribe link, ...).
 */
class Version5129Date20261101190000 extends SimpleMigrationStep {
	#[Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		$b = $schema->getTable('mail_bodies');
		$changed = false;
		if (!$b->hasColumn('reader_body')) {
			$b->addColumn('reader_body', Types::TEXT, ['notnull' => false]);
			$changed = true;
		}
		if (!$b->hasColumn('reader_meta')) {
			$b->addColumn('reader_meta', Types::TEXT, ['notnull' => false]);
			$changed = true;
		}
		return $changed ? $schema : null;
	}
}

<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Notes\Activity;

use OCP\Activity\ActivitySettings;
use OCP\IL10N;

/** Atrium: the Notes row in the activity settings (stream on, mail off by default). */
class Setting extends ActivitySettings {
	public function __construct(
		private IL10N $l,
	) {
	}

	public function getIdentifier(): string {
		return ActivityPublisher::TYPE;
	}

	public function getName(): string {
		return $this->l->t('A note was created, edited or deleted');
	}

	public function getGroupIdentifier(): string {
		return ActivityPublisher::APP;
	}

	public function getGroupName(): string {
		return $this->l->t('Notes');
	}

	public function getPriority(): int {
		return 50;
	}

	public function canChangeMail(): bool {
		return true;
	}

	public function isDefaultEnabledMail(): bool {
		return false;
	}
}

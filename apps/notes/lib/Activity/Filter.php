<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Notes\Activity;

use OCP\Activity\IFilter;
use OCP\IL10N;
use OCP\IURLGenerator;

/** Atrium: the "Notes" entry in the Activity app's navigation. */
class Filter implements IFilter {
	public function __construct(
		private IL10N $l,
		private IURLGenerator $urls,
	) {
	}

	public function getIdentifier(): string {
		return ActivityPublisher::APP;
	}

	public function getName(): string {
		return $this->l->t('Notes');
	}

	public function getPriority(): int {
		return 55;
	}

	public function getIcon(): string {
		return $this->urls->getAbsoluteURL($this->urls->imagePath(ActivityPublisher::APP, 'notes-dark.svg'));
	}

	public function filterTypes(array $types): array {
		return array_values(array_intersect($types, [ActivityPublisher::TYPE]));
	}

	public function allowedApps(): array {
		return [ActivityPublisher::APP];
	}
}

<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Activity;

use OCA\DailyTodo\Service\ActivityPublisher;
use OCP\Activity\ActivitySettings;
use OCP\IL10N;

/** One row in the Activity settings page per kind of event, all under the "Daily Todo" group. */
abstract class Setting extends ActivitySettings
{
    public function __construct(protected IL10N $l) {}

    public function getGroupIdentifier(): string
    {
        return ActivityPublisher::APP;
    }

    public function getGroupName(): string
    {
        return $this->l->t('Daily Todo');
    }
}

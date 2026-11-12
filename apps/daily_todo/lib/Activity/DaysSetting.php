<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Activity;

use OCA\DailyTodo\Service\ActivityPublisher;

final class DaysSetting extends Setting
{
    public function getIdentifier(): string
    {
        return ActivityPublisher::TYPE_DAYS;
    }

    public function getName(): string
    {
        return $this->l->t('A day was finished');
    }

    public function getPriority(): int
    {
        return 51;
    }
}

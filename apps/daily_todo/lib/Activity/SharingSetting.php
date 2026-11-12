<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Activity;

use OCA\DailyTodo\Service\ActivityPublisher;

final class SharingSetting extends Setting
{
    public function getIdentifier(): string
    {
        return ActivityPublisher::TYPE_SHARING;
    }

    public function getName(): string
    {
        return $this->l->t('A list was shared with you');
    }

    public function getPriority(): int
    {
        return 52;
    }
}

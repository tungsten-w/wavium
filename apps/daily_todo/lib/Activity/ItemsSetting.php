<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Activity;

use OCA\DailyTodo\Service\ActivityPublisher;

final class ItemsSetting extends Setting
{
    public function getIdentifier(): string
    {
        return ActivityPublisher::TYPE_ITEMS;
    }

    public function getName(): string
    {
        return $this->l->t('Items were added, completed, deleted, postponed or restored');
    }

    public function getPriority(): int
    {
        return 50;
    }
}

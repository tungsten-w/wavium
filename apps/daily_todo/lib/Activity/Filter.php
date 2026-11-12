<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Activity;

use OCA\DailyTodo\Service\ActivityPublisher;
use OCP\Activity\IFilter;
use OCP\IL10N;
use OCP\IURLGenerator;

/** The "Daily Todo" entry in the Activity app's sidebar. */
final class Filter implements IFilter
{
    public function __construct(private IL10N $l, private IURLGenerator $urls) {}

    public function getIdentifier(): string
    {
        return ActivityPublisher::APP;
    }

    public function getName(): string
    {
        return $this->l->t('Daily Todo');
    }

    public function getPriority(): int
    {
        return 60;
    }

    public function getIcon(): string
    {
        return $this->urls->imagePath(ActivityPublisher::APP, 'app-dark.svg');
    }

    public function filterTypes(array $types): array
    {
        return array_values(array_intersect($types, [ActivityPublisher::TYPE_ITEMS, ActivityPublisher::TYPE_DAYS, ActivityPublisher::TYPE_SHARING]));
    }

    public function allowedApps(): array
    {
        return [ActivityPublisher::APP];
    }
}

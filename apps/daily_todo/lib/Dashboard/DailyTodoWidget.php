<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Dashboard;

use OCA\DailyTodo\AppInfo\Application;
use OCA\DailyTodo\Service\BoardService;
use OCA\DailyTodo\Service\EntryTree;
use OCA\DailyTodo\Service\LogicalDate;
use OCP\Dashboard\IAPIWidget;
use OCP\Dashboard\IAPIWidgetV2;
use OCP\Dashboard\IButtonWidget;
use OCP\Dashboard\IIconWidget;
use OCP\Dashboard\Model\WidgetButton;
use OCP\Dashboard\Model\WidgetItem;
use OCP\Dashboard\Model\WidgetItems;
use OCP\IL10N;
use OCP\IURLGenerator;

/**
 * Today's unfinished items on the dashboard.
 *
 * Nextcloud's dashboard front end only renders a widget natively when it reports
 * API version 2, so IAPIWidgetV2 is required (IAPIWidget is kept for older clients).
 */
final class DailyTodoWidget implements IAPIWidget, IAPIWidgetV2, IButtonWidget, IIconWidget
{
    public function __construct(
        private BoardService $boards,
        private IL10N $l10n,
        private IURLGenerator $urlGenerator,
    ) {
    }

    public function getId(): string
    {
        return Application::APP_ID;
    }

    public function getTitle(): string
    {
        return $this->l10n->t('Daily Todo');
    }

    public function getOrder(): int
    {
        return 10;
    }

    public function getIconClass(): string
    {
        return '';
    }

    public function getIconUrl(): string
    {
        return $this->urlGenerator->getAbsoluteURL(
            $this->urlGenerator->imagePath('core', 'actions/checkmark.svg'),
        );
    }

    public function getUrl(): ?string
    {
        return $this->appUrl();
    }

    public function load(): void
    {
    }

    public function getItems(string $userId, ?string $since = null, int $limit = 7): array
    {
        return $this->collect($userId, $limit);
    }

    public function getItemsV2(string $userId, ?string $since = null, int $limit = 7): WidgetItems
    {
        return new WidgetItems(
            $this->collect($userId, $limit),
            $this->l10n->t('Nothing left to do today'),
        );
    }

    /** @return list<WidgetItem> */
    private function collect(string $userId, int $limit): array
    {
        $settings = $this->boards->settings($userId);
        $logicalToday = LogicalDate::forTimestamp(
            time(),
            $settings['timezone'],
            $settings['rolloverHour'],
        );
        $timezone = new \DateTimeZone($settings['timezone']);
        $day = $this->boards->getDay($userId, $logicalToday);
        $items = [];

        foreach ($day['items'] as $item) {
            // Dividers and gaps are layout, and finished items are not "left to do".
            if ($item['completed'] || EntryTree::separator((string) $item['title']) !== null) {
                continue;
            }
            $subtitle = ucfirst((string) $item['source_type']);
            if ($item['all_day']) {
                $subtitle .= ' · ' . $this->l10n->t('All day');
            } elseif ($item['starts_at']) {
                $start = (new \DateTimeImmutable('@' . (int) $item['starts_at']))->setTimezone($timezone);
                $subtitle .= ' · ' . $start->format('H:i');
            }
            $items[] = new WidgetItem(
                (string) $item['title'],
                $subtitle,
                $this->appUrl(),
                $this->getIconUrl(),
                (string) $item['id'],
            );
            if (count($items) >= $limit) {
                break;
            }
        }

        return $items;
    }

    public function getWidgetButtons(string $userId): array
    {
        return [
            new WidgetButton(
                WidgetButton::TYPE_MORE,
                $this->appUrl(),
                $this->l10n->t('Open Daily Todo'),
            ),
        ];
    }

    private function appUrl(): string
    {
        // Route generation can come back empty when the app's routes are not loaded
        // (e.g. outside a normal web request); never link to the site root then.
        $path = $this->urlGenerator->linkToRoute('daily_todo.page.index');

        return $this->urlGenerator->getAbsoluteURL($path !== '' ? $path : '/apps/daily_todo/');
    }
}

<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Dashboard;

use OCA\DailyTodo\AppInfo\Application;
use OCP\Dashboard\IButtonWidget;
use OCP\Dashboard\IIconWidget;
use OCP\Dashboard\IWidget;
use OCP\Dashboard\Model\WidgetButton;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\Util;

/**
 * A month calendar for the Dashboard: days tinted by how much was done, a click opens that
 * day, and the last 7 days' numbers sit below it. Unlike the list widget this one draws
 * itself (src/dashboard.ts), so it is not an API widget.
 */
final class DailyTodoCalendarWidget implements IWidget, IIconWidget, IButtonWidget
{
    public const ID = 'daily_todo_calendar';

    public function __construct(private IL10N $l10n, private IURLGenerator $urlGenerator)
    {
    }

    public function getId(): string
    {
        return self::ID;
    }

    public function getTitle(): string
    {
        return $this->l10n->t('Daily Todo calendar');
    }

    public function getOrder(): int
    {
        return 11;
    }

    /** A widget that draws itself gets its header icon from this class (see DashboardCalendar.vue), not from the URL below. */
    public function getIconClass(): string
    {
        return 'icon-daily-todo-calendar';
    }

    public function getIconUrl(): string
    {
        return $this->urlGenerator->getAbsoluteURL($this->urlGenerator->imagePath(Application::APP_ID, 'app-dark.svg'));
    }

    public function getUrl(): ?string
    {
        return $this->appUrl();
    }

    public function load(): void
    {
        Util::addScript(Application::APP_ID, 'daily-todo-dashboard');
        Util::addStyle(Application::APP_ID, 'daily-todo-dashboard');
    }

    public function getWidgetButtons(string $userId): array
    {
        return [new WidgetButton(WidgetButton::TYPE_MORE, $this->appUrl() . '#stats', $this->l10n->t('Open Stats'))];
    }

    private function appUrl(): string
    {
        $path = $this->urlGenerator->linkToRoute('daily_todo.page.index');

        return $this->urlGenerator->getAbsoluteURL($path !== '' ? $path : '/apps/daily_todo/');
    }
}

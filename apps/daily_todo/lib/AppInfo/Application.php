<?php

declare(strict_types=1);

namespace OCA\DailyTodo\AppInfo;

use OCA\DailyTodo\Dashboard\DailyTodoCalendarWidget;
use OCA\DailyTodo\Dashboard\DailyTodoWidget;
use OCA\DailyTodo\Search\SearchProvider;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

final class Application extends App implements IBootstrap
{
    public const APP_ID = 'daily_todo';

    public function __construct()
    {
        parent::__construct(self::APP_ID);
    }

    public function register(IRegistrationContext $context): void
    {
        $context->registerDashboardWidget(DailyTodoWidget::class);
        $context->registerDashboardWidget(DailyTodoCalendarWidget::class);
        $context->registerSearchProvider(SearchProvider::class);
    }

    public function boot(IBootContext $context): void
    {
    }
}

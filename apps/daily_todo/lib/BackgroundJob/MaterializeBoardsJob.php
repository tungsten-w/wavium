<?php

declare(strict_types=1);

namespace OCA\DailyTodo\BackgroundJob;

use OCA\DailyTodo\Service\BoardService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;

final class MaterializeBoardsJob extends TimedJob
{
    public function __construct(ITimeFactory $time, private BoardService $service)
    {
        parent::__construct($time);
        $this->setInterval(900);
    }protected function run($argument): void
    {
        $this->service->materializeAll();
    }
}

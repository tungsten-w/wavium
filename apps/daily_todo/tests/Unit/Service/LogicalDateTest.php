<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Tests\Unit\Service;

use OCA\DailyTodo\Service\LogicalDate;
use PHPUnit\Framework\TestCase;

final class LogicalDateTest extends TestCase
{
    public function testBeforeRolloverBelongsToPreviousCivilDay(): void
    {
        $timestamp = (new \DateTimeImmutable('2026-09-30 02:59:59', new \DateTimeZone('Europe/Paris')))
            ->getTimestamp();

        self::assertSame(
            '2026-09-29',
            LogicalDate::forTimestamp($timestamp, 'Europe/Paris', 3),
        );
    }

    public function testAtRolloverBelongsToCurrentCivilDay(): void
    {
        $timestamp = (new \DateTimeImmutable('2026-09-30 03:00:00', new \DateTimeZone('Europe/Paris')))
            ->getTimestamp();

        self::assertSame(
            '2026-09-30',
            LogicalDate::forTimestamp($timestamp, 'Europe/Paris', 3),
        );
    }

    public function testDstSpringTransition(): void
    {
        $timezone = new \DateTimeZone('Europe/Paris');
        $before = (new \DateTimeImmutable('2026-03-29 01:30:00', $timezone))->getTimestamp();
        $after = (new \DateTimeImmutable('2026-03-29 03:30:00', $timezone))->getTimestamp();

        self::assertSame('2026-03-28', LogicalDate::forTimestamp($before, 'Europe/Paris', 3));
        self::assertSame('2026-03-29', LogicalDate::forTimestamp($after, 'Europe/Paris', 3));
    }

    public function testOnlyTodayAndPreviousTwoDaysAreEditable(): void
    {
        self::assertTrue(LogicalDate::editable('2026-09-30', '2026-09-30'));
        self::assertTrue(LogicalDate::editable('2026-09-28', '2026-09-30'));
        self::assertFalse(LogicalDate::editable('2026-09-27', '2026-09-30'));
        self::assertTrue(LogicalDate::editable('2026-10-01', '2026-09-30'));
    }
}

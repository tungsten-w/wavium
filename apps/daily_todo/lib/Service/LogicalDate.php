<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Service;

final class LogicalDate
{
    public static function forTimestamp(
        int $timestamp,
        string $timezone,
        int $rolloverHour,
    ): string {
        $zone = new \DateTimeZone($timezone);
        $date = (new \DateTimeImmutable('@' . $timestamp))->setTimezone($zone);

        if ((int) $date->format('G') < $rolloverHour) {
            $date = $date->modify('-1 day');
        }

        return $date->format('Y-m-d');
    }

    public static function editable(string $day, string $logicalToday): bool
    {
        $date = new \DateTimeImmutable($day);
        $today = new \DateTimeImmutable($logicalToday);
        $ageInDays = (int) $date->diff($today)->format('%r%a');

        // Today and the two days before it; days that have not started yet do not exist.
        return $ageInDays >= 0 && $ageInDays <= 2;
    }
}

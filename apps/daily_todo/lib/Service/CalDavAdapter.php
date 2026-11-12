<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Service;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use Sabre\VObject\Component;
use Sabre\VObject\Reader;

final class CalDavAdapter
{
    public function __construct(private IDBConnection $db, private \OCA\DAV\CalDAV\CalDavBackend $backend) {}

    public function sources(string $uid): array
    {
        $q = $this->db->getQueryBuilder();
        $q->select('id', 'uri', 'displayname', 'components')->from('calendars')->where($q->expr()->eq('principaluri', $q->createNamedParameter('principals/users/' . $uid)))->andWhere($q->expr()->orX($q->expr()->isNull('deleted_at'), $q->expr()->eq('deleted_at', $q->createNamedParameter(0, IQueryBuilder::PARAM_INT))));
        $rows = $q->executeQuery()->fetchAllAssociative();
        $out = ['tasks' => [],'calendars' => []];
        foreach ($rows as $r) {
            $entry = ['id' => (string) $r['id'],'name' => $r['displayname'] ?: $r['uri']];
            if (str_contains((string) $r['components'], 'VTODO')) {
                $out['tasks'][] = $entry;
            }
            if (str_contains((string) $r['components'], 'VEVENT')) {
                $out['calendars'][] = $entry;
            }
        }
        return $out;
    }

    /**
     * Entries for one day. A task is listed when its start date (or, without one,
     * its due date) is that day;
     * all of its subtasks (RELATED-TO) are listed under it whatever their own
     * dates, so the day shows the same checklist as the Tasks app. Subtasks
     * carry `parent_key`; see EntryTree.
     */
    public function entries(string $uid, string $day, array $taskLists, array $calendars, bool $includeOverdue = false): array
    {
        if (!$taskLists && !$calendars) {
            return [];
        }
        $principal = 'principals/users/' . $uid;
        // Tasks are few, and a task on the day needs the whole set to find its subtasks.
        $rows = $taskLists ? $this->objects($principal, 'VTODO', $taskLists) : [];
        // Events: Nextcloud keeps every event's first and last time in indexed columns, so only
        // the events near this day are read and parsed, not every event in every calendar.
        if ($calendars) {
            $dayStart = (new \DateTimeImmutable($day . ' 00:00:00', new \DateTimeZone('UTC')))->getTimestamp();
            // Generous margin: event times are stored in UTC, the day check below is exact.
            $rows = array_merge($rows, $this->objects($principal, 'VEVENT', $calendars, [$dayStart - 2 * 86400, $dayStart + 3 * 86400]));
        }
        $events = [];
        $tasks = [];
        foreach ($rows as $r) {
            try {
                $v = Reader::read($r['calendardata']);
                $component = $v->VTODO ?? $v->VEVENT ?? null;
                if (!$component) {
                    continue;
                }
                $isTask = $component->name === 'VTODO';
                if (!in_array((string) $r['calendarid'], $isTask ? $taskLists : $calendars, true)) {
                    continue;
                }
                $sourceId = $r['calendarid'] . ':' . $r['uri'];
                $prop = $component->DTSTART ?? null;
                $start = $prop?->getDateTime();
                $due = $component->DUE?->getDateTime();
                // Tasks usually only have a due date: it places a task without a start date.
                $placing = $isTask ? ($prop ?? $component->DUE ?? null) : $prop;
                $allDay = $placing !== null && !str_contains((string) $placing, 'T');

                if (!$isTask) {
                    $events = array_merge($events, self::eventsOn($v, $day, $sourceId));
                    continue;
                }

                $uidValue = (string) ($component->UID ?? '');
                $placingDay = ($start ?? $due)?->format('Y-m-d');
                $parentUid = $this->parentUid($component);
                $unfinished = !in_array(strtoupper((string) ($component->STATUS ?? '')), ['COMPLETED', 'CANCELLED'], true);
                // Regeneration can rebuild overdue roots from the current Tasks data,
                // including their whole subtask tree, without changing their dates.
                $overdue = $includeOverdue && $placingDay !== null && $placingDay < $day
                    && $unfinished && $parentUid === null && !isset($component->RRULE) && !isset($component->RDATE);
                $tasks[$uidValue !== '' ? $uidValue : $sourceId] = [
                    'parent_uid' => $parentUid,
                    'matches' => $placingDay === $day || $overdue,
                    'entry' => ['source_type' => 'task','source_id' => $sourceId,'title' => (string) ($component->SUMMARY ?? '(untitled)'),'starts_at' => $start && !$allDay ? $start->getTimestamp() : null,'due_at' => $due?->getTimestamp(),'all_day' => $allDay,'completed' => strtoupper((string) ($component->STATUS ?? '')) === 'COMPLETED','href' => '/apps/tasks/'],
                ];
            } catch (\Throwable) {
                continue;
            }
        }

        return array_merge($events, $this->taskEntries($tasks));
    }

    /**
     * The entries one calendar object puts on a day. A repeating event (RRULE/RDATE, with its
     * exceptions and moved instances) is expanded for the days around it, so a yearly birthday
     * shows on every year's date. Instance times are read back in the event's own time zone,
     * so "00:30 in Paris" stays on that date. A second instance on the same day gets a
     * suffix in its source id, so every entry stays unique.
     *
     * @return list<array<string, mixed>>
     */
    public static function eventsOn(\Sabre\VObject\Component\VCalendar $calendar, string $day, string $sourceId): array
    {
        $components = $calendar->select('VEVENT');
        $zone = null;
        foreach ($components as $component) {
            if (isset($component->RRULE) || isset($component->RDATE)) {
                $first = new \DateTimeImmutable($day . ' 00:00:00', new \DateTimeZone('UTC'));
                $zone = null;
                foreach ($components as $candidate) {
                    $zone ??= $candidate->DTSTART?->getDateTime()->getTimezone();
                }
                $components = $calendar->expand($first->modify('-2 days'), $first->modify('+3 days'), new \DateTimeZone('UTC'))->select('VEVENT');
                break;
            }
        }
        $out = [];
        foreach ($components as $component) {
            $prop = $component->DTSTART ?? null;
            $start = $prop?->getDateTime();
            if (!$start) {
                continue;
            }
            $allDay = !str_contains((string) $prop, 'T');
            $end = $component->DTEND?->getDateTime();
            if ($zone !== null && !$allDay) {
                $start = $start->setTimezone($zone);
                $end = $end?->setTimezone($zone);
            }
            $date = $start->format('Y-m-d');
            $multi = $end && $day >= $date && $day < $end->format('Y-m-d');
            if ($date !== $day && !$multi) {
                continue;
            }
            $out[] = [
                'source_type' => 'event',
                'source_id' => $out ? $sourceId . '@' . $start->getTimestamp() : $sourceId,
                'title' => (string) ($component->SUMMARY ?? '(untitled)'),
                'starts_at' => $allDay ? null : $start->getTimestamp(),
                'due_at' => null,
                'all_day' => $allDay,
                'completed' => false,
                'href' => '/apps/calendar/',
            ];
        }

        return $out;
    }

    /**
     * Calendar objects of one component type in the given calendars. With a window, only
     * those that may overlap it (objects without stored times are always kept).
     *
     * @param list<string> $calendarIds
     * @param array{0: int, 1: int}|null $window [from, to] as Unix timestamps
     * @return list<array{calendarid: int|string, uri: string, calendardata: string}>
     */
    private function objects(string $principal, string $type, array $calendarIds, ?array $window = null): array
    {
        $q = $this->db->getQueryBuilder();
        $q->select('o.calendarid', 'o.uri', 'o.calendardata')->from('calendarobjects', 'o')
            ->innerJoin('o', 'calendars', 'c', $q->expr()->eq('c.id', 'o.calendarid'))
            ->where($q->expr()->eq('c.principaluri', $q->createNamedParameter($principal)))
            ->andWhere($q->expr()->in('o.calendarid', $q->createNamedParameter(array_map('intval', $calendarIds), IQueryBuilder::PARAM_INT_ARRAY)))
            ->andWhere($q->expr()->eq('o.componenttype', $q->createNamedParameter($type)))
            ->andWhere($q->expr()->isNull('o.deleted_at'));
        if ($window !== null) {
            $from = $q->createNamedParameter($window[0], IQueryBuilder::PARAM_INT);
            $to = $q->createNamedParameter($window[1], IQueryBuilder::PARAM_INT);
            $q->andWhere($q->expr()->orX(
                $q->expr()->isNull('o.firstoccurence'),
                $q->expr()->andX(
                    $q->expr()->lte('o.firstoccurence', $to),
                    $q->expr()->orX(
                        $q->expr()->gte('o.lastoccurence', $from),
                        $q->expr()->andX($q->expr()->isNull('o.lastoccurence'), $q->expr()->gte('o.firstoccurence', $from)),
                    ),
                ),
            ));
        }

        return $q->executeQuery()->fetchAllAssociative();
    }

    /**
     * @param array<string, array{parent_uid: ?string, matches: bool, entry: array}> $tasks keyed by task UID
     */
    private function taskEntries(array $tasks): array
    {
        $children = [];
        foreach ($tasks as $uid => $task) {
            if ($task['parent_uid'] !== null && $task['parent_uid'] !== $uid && isset($tasks[$task['parent_uid']])) {
                $children[$task['parent_uid']][] = $uid;
            }
        }

        $included = [];
        $include = function (string $uid) use (&$include, &$included, $children): void {
            if (isset($included[$uid])) {
                return;
            }
            $included[$uid] = true;
            foreach ($children[$uid] ?? [] as $child) {
                $include($child);
            }
        };
        foreach ($tasks as $uid => $task) {
            if ($task['matches']) {
                $include($uid);
            }
        }

        $out = [];
        foreach (array_keys($included) as $uid) {
            $entry = $tasks[$uid]['entry'];
            $parent = $tasks[$uid]['parent_uid'];
            $entry['parent_key'] = $parent !== null && isset($included[$parent]) && $parent !== $uid
                ? 'task:' . $tasks[$parent]['entry']['source_id']
                : null;
            $out[] = $entry;
        }

        return $out;
    }

    private function parentUid(Component $component): ?string
    {
        foreach ($component->select('RELATED-TO') as $related) {
            $type = strtoupper((string) ($related['RELTYPE'] ?? 'PARENT'));
            if ($type === 'PARENT' && (string) $related !== '') {
                return (string) $related;
            }
        }

        return null;
    }

    /** The date a task is placed on: its start date, or without one its due date (as `entries()` does). */
    public static function taskPlacingDate(string $calendarData): string
    {
        $task = Reader::read($calendarData)->VTODO ?? throw new \RuntimeException('The source is no longer a task.');
        $placing = ($task->DTSTART ?? null)?->getDateTime() ?? ($task->DUE ?? null)?->getDateTime();
        if (!$placing) {
            throw new \RuntimeException('This task has no date to move.');
        }

        return $placing->format('Y-m-d');
    }

    /**
     * The calendar data with the task's start and due dates moved by $days days (both, so its
     * length stays the same). All-day dates stay all-day and times keep their time zone. A
     * repeating task is refused: moving it would change the whole series.
     */
    public static function withShiftedDates(string $calendarData, int $days): string
    {
        $v = Reader::read($calendarData);
        $task = $v->VTODO ?? throw new \RuntimeException('The source is no longer a task.');
        if (isset($task->RRULE) || isset($task->RDATE)) {
            throw new \RuntimeException('A repeating task cannot be postponed here. Change it in Tasks.');
        }
        $moved = false;
        foreach (['DTSTART', 'DUE'] as $name) {
            $prop = $task->$name ?? null;
            if (!$prop) {
                continue;
            }
            $shifted = $prop->getDateTime()->modify(sprintf('%+d days', $days));
            if (str_contains((string) $prop, 'T')) {
                $prop->setDateTime($shifted, $prop->isFloating());
            } else {
                $prop->setValue($shifted->format('Ymd'));
            }
            $moved = true;
        }
        if (!$moved) {
            throw new \RuntimeException('This task has no date to move.');
        }
        $task->{'LAST-MODIFIED'} = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Ymd\THis\Z');

        return $v->serialize();
    }

    /** Trash the real task tree, keeping exact VTODOs and object identities for Undo. */
    public function trashTask(string $uid, string $sourceId, array $taskLists): array
    {
        $objects = $this->objects('principals/users/' . $uid, 'VTODO', $taskLists);
        $tasks = [];
        foreach ($objects as $object) {
            $task = Reader::read($object['calendardata'])->VTODO;
            $key = $object['calendarid'] . ':' . $object['uri'];
            $tasks[$key] = ['object' => $object, 'uid' => (string) $task->UID, 'parent' => $this->parentUid($task)];
        }
        if (!isset($tasks[$sourceId])) {
            throw new \RuntimeException('The source task was deleted or its list is no longer enabled.');
        }
        $selected = [$sourceId => true];
        do {
            $added = false;
            $uids = [];
            foreach ($selected as $key => $_) $uids[$tasks[$key]['uid']] = true;
            foreach ($tasks as $key => $task) {
                if (!isset($selected[$key]) && $task['parent'] !== null && isset($uids[$task['parent']])) {
                    $selected[$key] = true;
                    $added = true;
                }
            }
        } while ($added);
        $copies = [];
        foreach ($selected as $key => $_) {
            $object = $tasks[$key]['object'];
            $stored = $this->backend->getCalendarObject((int) $object['calendarid'], $object['uri']);
            $copies[] = ['calendarid' => (int) $object['calendarid'], 'uri' => $object['uri'],
                'calendardata' => $stored['calendardata'], 'id' => (int) $stored['id']];
            $this->backend->deleteCalendarObject((int) $object['calendarid'], $object['uri']);
        }
        return $copies;
    }

    /** Restore only our own trashed identities; never overwrite a recreated task. */
    public function restoreTasks(array $copies): void
    {
        foreach ($copies as $copy) {
            $q = $this->db->getQueryBuilder();
            $q->select('id', 'uri', 'calendarid', 'deleted_at')->from('calendarobjects')
                ->where($q->expr()->eq('id', $q->createNamedParameter((int) $copy['id'], IQueryBuilder::PARAM_INT)));
            $object = $q->executeQuery()->fetchAssociative();
            if ($object && $object['deleted_at'] === null && $object['uri'] === $copy['uri']) continue; // restored in Tasks already
            if ($object) {
                // The backend derives its restore URI from this value. Supply the original URI
                // so extensionless names are restored correctly too.
                $object['uri'] = $copy['uri'];
                $this->backend->restoreCalendarObject($object);
            } else {
                // DAV trash retention may be disabled or its copy may have expired.
                if ($this->backend->getCalendarObject((int) $copy['calendarid'], $copy['uri']) !== null) {
                    throw new \RuntimeException('A different task now uses this address; it cannot be overwritten.');
                }
                $this->backend->createCalendarObject((int) $copy['calendarid'], $copy['uri'], $copy['calendardata']);
            }
        }
    }

    /** Move a task so that it is placed on $targetDate (Y-m-d). Returns how many days it moved. */
    public function shiftTask(string $sourceId, string $targetDate): int
    {
        [$calendarId, $uri] = explode(':', $sourceId, 2);
        $object = $this->backend->getCalendarObject((int) $calendarId, $uri) ?? throw new \RuntimeException('The source task was deleted.');
        $placing = new \DateTimeImmutable(self::taskPlacingDate($object['calendardata']));
        $days = (int) $placing->diff(new \DateTimeImmutable($targetDate))->format('%r%a');
        $this->backend->updateCalendarObject((int) $calendarId, $uri, self::withShiftedDates($object['calendardata'], $days));

        return $days;
    }

    /** Move a task's dates by a number of days (negative = earlier), for undo. */
    public function shiftTaskBy(string $sourceId, int $days): void
    {
        [$calendarId, $uri] = explode(':', $sourceId, 2);
        $object = $this->backend->getCalendarObject((int) $calendarId, $uri) ?? throw new \RuntimeException('The source task was deleted.');
        $this->backend->updateCalendarObject((int) $calendarId, $uri, self::withShiftedDates($object['calendardata'], $days));
    }

    /**
     * What the task editor shows: the task as it is stored in Tasks. Dates are plain days
     * (Y-m-d) or null.
     *
     * @return array{title: string, description: string, start: ?string, due: ?string, priority: int, repeating: bool}
     */
    public static function detailsOf(string $calendarData): array
    {
        $task = Reader::read($calendarData)->VTODO ?? throw new \RuntimeException('The source is no longer a task.');

        return [
            'title' => (string) ($task->SUMMARY ?? ''),
            'description' => (string) ($task->DESCRIPTION ?? ''),
            'start' => ($task->DTSTART ?? null)?->getDateTime()->format('Y-m-d'),
            'due' => ($task->DUE ?? null)?->getDateTime()->format('Y-m-d'),
            'priority' => (int) ($task->PRIORITY ?? 0),
            'repeating' => isset($task->RRULE) || isset($task->RDATE),
        ];
    }

    /**
     * The calendar data with the edited fields applied; everything else (categories, alarms,
     * the time of day of a dated time, the time zone, ...) is left as it was. Dates that did
     * not change are not touched. A repeating task's dates cannot be changed here.
     *
     * @param array{title: string, description: string, start: ?string, due: ?string, priority: int} $edit
     */
    public static function withEdits(string $calendarData, array $edit): string
    {
        $v = Reader::read($calendarData);
        $task = $v->VTODO ?? throw new \RuntimeException('The source is no longer a task.');
        $title = trim($edit['title']);
        if ($title === '') {
            throw new \RuntimeException('A title is required');
        }
        if ($edit['priority'] < 0 || $edit['priority'] > 9) {
            throw new \RuntimeException('Invalid priority');
        }
        foreach (['start', 'due'] as $field) {
            $date = $edit[$field];
            if ($date !== null && !self::isDay($date)) {
                throw new \RuntimeException('Invalid date');
            }
        }
        if ($edit['start'] !== null && $edit['due'] !== null && $edit['due'] < $edit['start']) {
            throw new \RuntimeException('The due date cannot be before the start date');
        }

        $task->SUMMARY = $title;
        self::setOrRemove($task, 'DESCRIPTION', trim($edit['description']) === '' ? null : $edit['description']);
        self::setOrRemove($task, 'PRIORITY', $edit['priority'] === 0 ? null : (string) $edit['priority']);
        $repeating = isset($task->RRULE) || isset($task->RDATE);
        foreach (['DTSTART' => 'start', 'DUE' => 'due'] as $name => $field) {
            $current = ($task->$name ?? null)?->getDateTime()->format('Y-m-d');
            if ($current === $edit[$field]) {
                continue;
            }
            if ($repeating) {
                throw new \RuntimeException('The dates of a repeating task can only be changed in Tasks.');
            }
            self::setDay($task, $name, $edit[$field]);
        }
        $task->{'LAST-MODIFIED'} = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Ymd\THis\Z');

        return $v->serialize();
    }

    /** A real calendar day written as Y-m-d (PHP alone would accept 2026-13-45 and roll it over). */
    public static function isDay(string $date): bool
    {
        $parsed = \DateTimeImmutable::createFromFormat('!Y-m-d', $date);

        return $parsed !== false && $parsed->format('Y-m-d') === $date;
    }

    private static function setOrRemove(Component $task, string $name, ?string $value): void
    {
        if ($value === null) {
            $task->remove($name);
        } else {
            $task->$name = $value;
        }
    }

    /** Set a task's start or due to a day: a dated time keeps its time of day and zone, otherwise it becomes an all-day date. */
    private static function setDay(Component $task, string $name, ?string $date): void
    {
        $prop = $task->$name ?? null;
        if ($date === null) {
            $task->remove($name);
        } elseif ($prop && str_contains((string) $prop, 'T')) {
            [$year, $month, $day] = array_map('intval', explode('-', $date));
            $prop->setDateTime($prop->getDateTime()->setDate($year, $month, $day), $prop->isFloating());
        } else {
            $task->remove($name);
            $task->add($name, str_replace('-', '', $date), ['VALUE' => 'DATE']);
        }
    }

    /** @return array{title: string, description: string, start: ?string, due: ?string, priority: int, repeating: bool} */
    public function taskDetails(string $sourceId): array
    {
        [$calendarId, $uri] = explode(':', $sourceId, 2);
        $object = $this->backend->getCalendarObject((int) $calendarId, $uri) ?? throw new \RuntimeException('The source task was deleted.');

        return self::detailsOf($object['calendardata']);
    }

    /** @param array{title: string, description: string, start: ?string, due: ?string, priority: int} $edit */
    public function editTask(string $sourceId, array $edit): void
    {
        [$calendarId, $uri] = explode(':', $sourceId, 2);
        $object = $this->backend->getCalendarObject((int) $calendarId, $uri) ?? throw new \RuntimeException('The source task was deleted.');
        $this->backend->updateCalendarObject((int) $calendarId, $uri, self::withEdits($object['calendardata'], $edit));
    }

    /**
     * Unfinished top-level tasks whose date has passed (oldest first, at most 50), for the
     * "overdue" nudge. Repeating tasks and subtasks are left out.
     *
     * @param list<string> $taskLists
     * @return list<array{id: string, title: string, date: string}>
     */
    public function overdueTasks(string $uid, string $today, array $taskLists): array
    {
        if (!$taskLists) {
            return [];
        }
        $out = [];
        foreach ($this->objects('principals/users/' . $uid, 'VTODO', $taskLists) as $row) {
            try {
                $task = Reader::read($row['calendardata'])->VTODO ?? null;
                if (!$task || isset($task->RRULE) || isset($task->RDATE) || $this->parentUid($task) !== null) {
                    continue;
                }
                if (in_array(strtoupper((string) ($task->STATUS ?? '')), ['COMPLETED', 'CANCELLED'], true)) {
                    continue;
                }
                $placing = ($task->DTSTART ?? null)?->getDateTime() ?? ($task->DUE ?? null)?->getDateTime();
                if (!$placing || $placing->format('Y-m-d') >= $today) {
                    continue;
                }
                $out[] = ['id' => $row['calendarid'] . ':' . $row['uri'], 'title' => (string) ($task->SUMMARY ?? '(untitled)'), 'date' => $placing->format('Y-m-d')];
            } catch (\Throwable) {
                continue;
            }
        }
        usort($out, fn($a, $b) => [$a['date'], $a['title']] <=> [$b['date'], $b['title']]);

        return array_slice($out, 0, 50);
    }

    public function setTaskTitle(string $sourceId, string $title): void
    {
        [$calendarId,$uri] = explode(':', $sourceId, 2);
        $object = $this->backend->getCalendarObject((int) $calendarId, $uri);
        if (!$object) {
            throw new \RuntimeException('The source task was deleted.');
        }
        $this->backend->updateCalendarObject((int) $calendarId, $uri, self::withSummary($object['calendardata'], $title));
    }

    /** Verify a missing checklist event was moved, rather than deleting it on a read failure. */
    public function eventMovedOffDay(string $sourceId, string $day): bool
    {
        try {
            [$calendarId, $uri] = explode(':', $sourceId, 2);
            $object = $this->backend->getCalendarObject((int) $calendarId, $uri);
            if (!$object) {
                return false;
            }
            $v = Reader::read($object['calendardata']);
            $event = $v->VEVENT ?? null;
            // Recurring instances need occurrence-aware reconciliation, not the series start.
            if (!$event || isset($event->RRULE) || isset($event->RDATE) || isset($event->{'RECURRENCE-ID'})) {
                return false;
            }
            $start = $event->DTSTART?->getDateTime()?->format('Y-m-d');
            $end = $event->DTEND?->getDateTime()?->format('Y-m-d');
            return self::eventDateMovedOffDay($start, $end, $day);
        } catch (\Throwable) {
            return false;
        }
    }

    public static function eventDateMovedOffDay(?string $start, ?string $end, string $day): bool
    {
        return $start !== null && $start !== $day
            && !($end !== null && $day >= $start && $day < $end);
    }

    /** The calendar data with the task's SUMMARY replaced; everything else is left as it was. */
    public static function withSummary(string $calendarData, string $title): string
    {
        $v = Reader::read($calendarData);
        $task = $v->VTODO ?? throw new \RuntimeException('The source is no longer a task.');
        $task->SUMMARY = $title;
        $task->{'LAST-MODIFIED'} = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Ymd\THis\Z');

        return $v->serialize();
    }

    public function setTaskCompleted(string $sourceId, bool $complete): void
    {
        [$calendarId,$uri] = explode(':', $sourceId, 2);
        $object = $this->backend->getCalendarObject((int) $calendarId, $uri);
        if (!$object) {
            throw new \RuntimeException('The source task was deleted.');
        }
        $v = Reader::read($object['calendardata']);
        $task = $v->VTODO;
        if (!$task) {
            throw new \RuntimeException('The source is no longer a task.');
        }
        $task->STATUS = $complete ? 'COMPLETED' : 'NEEDS-ACTION';
        $task->{'PERCENT-COMPLETE'} = $complete ? '100' : '0';
        if ($complete) {
            $task->COMPLETED = (new \DateTimeImmutable())->format('Ymd\THis\Z');
        } else {
            unset($task->COMPLETED);
        }
        $this->backend->updateCalendarObject((int) $calendarId, $uri, $v->serialize());
    }
}

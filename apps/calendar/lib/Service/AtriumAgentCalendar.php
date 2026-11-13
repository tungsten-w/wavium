<?php

declare(strict_types=1);

// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace OCA\Calendar\Service;

use OCA\DAV\CalDAV\CalDavBackend;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\Component\VTodo;
use Sabre\VObject\Reader;

/**
 * Calendar and Tasks for the Atrium agent layer (server/agent/calendar, P3-2).
 *
 * Simple fields in and out, never raw iCalendar. Everything goes through
 * CalDavBackend, so DAV clients (phones, Thunderbird) see the changes at once
 * and the change log (calendarchanges) feeds the calendar.* / task.* events.
 *
 * Calendars a user can see: their own, the ones shared with them (read-only or
 * read-write) and their subscriptions (read-only, events only). Writes check
 * that the calendar is the user's or shared read-write: CalDavBackend itself
 * does no ACL check. Deleting moves the object to the calendar trash bin
 * (kept 30 days by default), never a hard delete.
 *
 * Ids: "<calendar id>/<object uri>" for events and tasks, "<id>" for calendars,
 * "sub-<id>" for subscriptions.
 */
final class AtriumAgentCalendar
{
    private const RO = '{http://owncloud.org/ns}read-only';
    private const OWNER = '{http://owncloud.org/ns}owner-principal';
    private const COMPS = '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set';
    public const MAX_RANGE_DAYS = 366;
    public const MAX_ITEMS = 500;

    public function __construct(private CalDavBackend $backend)
    {
    }

    private static function principal(string $uid): string
    {
        return 'principals/users/' . $uid;
    }

    /** @return list<array<string, mixed>> */
    public function calendars(string $uid): array
    {
        $out = [];
        foreach ($this->backend->getCalendarsForUser(self::principal($uid)) as $c) {
            if (str_starts_with((string) $c['uri'], 'contact_birthdays') || isset($c['{http://nextcloud.com/ns}deleted-at']) && $c['{http://nextcloud.com/ns}deleted-at']) {
                continue;
            }
            $owner = isset($c[self::OWNER]) ? basename((string) $c[self::OWNER]) : $uid;
            $comps = isset($c[self::COMPS]) ? $c[self::COMPS]->getValue() : ['VEVENT', 'VTODO'];
            $out[] = [
                'calendar_id' => (string) $c['id'],
                'name' => (string) ($c['{DAV:}displayname'] ?? $c['uri']),
                'color' => $c['{http://apple.com/ns/ical/}calendar-color'] ?? null,
                'events' => in_array('VEVENT', $comps, true),
                'tasks' => in_array('VTODO', $comps, true),
                'writable' => $owner === $uid || empty($c[self::RO]),
                'owner' => $owner,
                'shared_by' => $owner === $uid ? null : $owner,
                'subscription' => false,
            ];
        }
        foreach ($this->backend->getSubscriptionsForUser(self::principal($uid)) as $s) {
            $out[] = [
                'calendar_id' => 'sub-' . $s['id'],
                'name' => (string) ($s['{DAV:}displayname'] ?? $s['uri']),
                'color' => $s['{http://apple.com/ns/ical/}calendar-color'] ?? null,
                'events' => true,
                'tasks' => false,
                'writable' => false,
                'owner' => $uid,
                'shared_by' => null,
                'subscription' => true,
                'source' => (string) ($s['source'] ?? ''),
            ];
        }
        return $out;
    }

    /** @return array{0: int, 1: int, 2: array<string, mixed>} [id, calendarType, calendar view] */
    private function calendar(string $uid, string $calendarId, bool $write = false): array
    {
        foreach ($this->calendars($uid) as $c) {
            if ($c['calendar_id'] === $calendarId) {
                if ($write && !$c['writable']) {
                    throw new AtriumAgentError(403, $c['subscription'] ? 'Subscriptions are read-only' : 'This calendar is shared read-only with you');
                }
                return $c['subscription']
                    ? [(int) substr($calendarId, 4), CalDavBackend::CALENDAR_TYPE_SUBSCRIPTION, $c]
                    : [(int) $calendarId, CalDavBackend::CALENDAR_TYPE_CALENDAR, $c];
            }
        }
        throw new AtriumAgentError(404, "No calendar $calendarId");
    }

    /** The first writable calendar of the user that takes this component (their default). */
    private function defaultCalendar(string $uid, string $comp): string
    {
        foreach ($this->calendars($uid) as $c) {
            if ($c['writable'] && $c['owner'] === $uid && $c[$comp === 'VTODO' ? 'tasks' : 'events']) {
                return $c['calendar_id'];
            }
        }
        throw new AtriumAgentError(404, $comp === 'VTODO' ? 'No calendar that takes tasks' : 'No calendar that takes events');
    }

    /** @return array{0: string, 1: string} */
    public static function splitId(string $id): array
    {
        if (!preg_match('#^(sub-\d+|\d+)/([^/]+)$#', $id, $m)) {
            throw new \InvalidArgumentException("Not an id: $id (expected \"<calendar id>/<object>\")");
        }
        return [$m[1], $m[2]];
    }

    /** @return array{0: array<string, mixed>, 1: VCalendar, 2: int, 3: int, 4: array<string, mixed>} */
    private function object(string $uid, string $id, bool $write = false): array
    {
        [$cal, $uri] = self::splitId($id);
        [$calId, $type, $c] = $this->calendar($uid, $cal, $write);
        $o = $this->backend->getCalendarObject($calId, $uri, $type);
        if (!$o) {
            throw new AtriumAgentError(404, "No event or task $id");
        }
        return [$o, Reader::read($o['calendardata']), $calId, $type, $c];
    }

    private static function dt(?\Sabre\VObject\Property $p): ?string
    {
        if (!$p instanceof \Sabre\VObject\Property\ICalendar\DateTime) {
            return null;
        }
        if (!$p->hasTime()) {
            return $p->getDateTime()->format('Y-m-d');
        }
        return $p->getDateTime()->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
    }

    private static function text(mixed $p): ?string
    {
        if ($p === null) {
            return null;
        }
        $v = trim((string) $p);
        return $v === '' ? null : $v;
    }

    /** @return array<string, mixed> */
    private function eventView(string $calendarId, string $uri, VEvent $e, ?string $etag, bool $occurrence = false): array
    {
        $attendees = [];
        foreach ($e->select('ATTENDEE') as $a) {
            $attendees[] = [
                'email' => preg_replace('/^mailto:/i', '', (string) $a->getValue()),
                'name' => isset($a['CN']) ? (string) $a['CN'] : null,
                'status' => isset($a['PARTSTAT']) ? strtolower((string) $a['PARTSTAT']) : null,
            ];
        }
        $start = self::dt($e->DTSTART);
        $end = self::dt($e->DTEND);
        if ($end === null && $e->DTSTART !== null && isset($e->DURATION)) {
            $s = \DateTimeImmutable::createFromInterface($e->DTSTART->getDateTime())->add($e->DURATION->getDateInterval());
            $end = $e->DTSTART->hasTime() ? $s->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z') : $s->format('Y-m-d');
        }
        return [
            'event_id' => "$calendarId/$uri",
            'calendar_id' => $calendarId,
            'title' => self::text($e->SUMMARY) ?? '',
            'start' => $start,
            'end' => $end,
            'all_day' => $e->DTSTART !== null && !$e->DTSTART->hasTime(),
            'location' => self::text($e->LOCATION),
            'description' => self::text($e->DESCRIPTION),
            'status' => isset($e->STATUS) ? strtolower((string) $e->STATUS) : null,
            'recurring' => isset($e->RRULE) || isset($e->{'RECURRENCE-ID'}) || $occurrence,
            'rrule' => isset($e->RRULE) ? (string) $e->RRULE : null,
            'occurrence' => isset($e->{'RECURRENCE-ID'}) ? self::dt($e->{'RECURRENCE-ID'}) : null,
            'organizer' => isset($e->ORGANIZER) ? preg_replace('/^mailto:/i', '', (string) $e->ORGANIZER->getValue()) : null,
            'attendees' => $attendees,
            'etag' => $etag,
        ];
    }

    /** @return array<string, mixed> */
    private function taskView(string $calendarId, string $uri, VTodo $t, ?string $etag): array
    {
        $status = isset($t->STATUS) ? strtoupper((string) $t->STATUS) : 'NEEDS-ACTION';
        $parent = null;
        foreach ($t->select('RELATED-TO') as $r) {
            if (!isset($r['RELTYPE']) || strtoupper((string) $r['RELTYPE']) === 'PARENT') {
                $parent = (string) $r;
            }
        }
        return [
            'task_id' => "$calendarId/$uri",
            'calendar_id' => $calendarId,
            'uid' => (string) $t->UID,
            'title' => self::text($t->SUMMARY) ?? '',
            'done' => $status === 'COMPLETED' || isset($t->COMPLETED),
            'status' => strtolower($status),
            'start' => self::dt($t->DTSTART),
            'due' => self::dt($t->DUE),
            'completed_at' => self::dt($t->COMPLETED),
            'priority' => isset($t->PRIORITY) ? (int) (string) $t->PRIORITY : null,
            'percent' => isset($t->{'PERCENT-COMPLETE'}) ? (int) (string) $t->{'PERCENT-COMPLETE'} : null,
            'description' => self::text($t->DESCRIPTION),
            'parent_uid' => $parent,
            'categories' => isset($t->CATEGORIES) ? $t->CATEGORIES->getParts() : [],
            'recurring' => isset($t->RRULE),
            'etag' => $etag,
        ];
    }

    private static function filter(string $comp, ?array $range = null): array
    {
        return ['name' => 'VCALENDAR', 'comp-filters' => [[
            'name' => $comp, 'comp-filters' => [], 'prop-filters' => [], 'is-not-defined' => false, 'time-range' => $range,
        ]], 'prop-filters' => [], 'is-not-defined' => false, 'time-range' => null];
    }

    /**
     * Event occurrences between $from and $to (recurrences expanded), sorted by start.
     *
     * @return array{events: list<array<string, mixed>>, truncated: bool}
     */
    public function events(string $uid, \DateTimeImmutable $from, \DateTimeImmutable $to, ?string $calendarId = null, ?string $query = null, int $limit = 100): array
    {
        if ($to <= $from) {
            throw new \InvalidArgumentException('to must be after from');
        }
        if ($from->diff($to)->days > self::MAX_RANGE_DAYS) {
            throw new \InvalidArgumentException('The range is limited to ' . self::MAX_RANGE_DAYS . ' days');
        }
        $limit = max(1, min(self::MAX_ITEMS, $limit));
        $cals = $calendarId !== null ? [$this->calendar($uid, $calendarId)[2]] : array_filter($this->calendars($uid), fn($c) => $c['events']);
        $out = [];
        foreach ($cals as $c) {
            [$id, $type] = $this->calendar($uid, $c['calendar_id']);
            $uris = $this->backend->calendarQuery($id, self::filter('VEVENT', ['start' => $from, 'end' => $to]), $type);
            foreach (array_chunk($uris, 100) as $chunk) {
                foreach ($this->backend->getMultipleCalendarObjects($id, $chunk, $type) as $o) {
                    $vcal = Reader::read($o['calendardata']);
                    $recurring = isset($vcal->VEVENT->RRULE);
                    try {
                        $expanded = $vcal->expand($from, $to);
                    } catch (\Throwable) {
                        continue; // a broken recurrence rule: skip the object, not the whole list
                    }
                    foreach ($expanded->select('VEVENT') as $e) {
                        $v = $this->eventView($c['calendar_id'], (string) $o['uri'], $e, $o['etag'] ?? null, $recurring);
                        if ($query !== null && $query !== '' && stripos($v['title'] . ' ' . ($v['location'] ?? '') . ' ' . ($v['description'] ?? ''), $query) === false) {
                            continue;
                        }
                        $v['calendar_name'] = $c['name'];
                        $out[] = $v;
                    }
                }
            }
        }
        usort($out, fn($a, $b) => strcmp((string) $a['start'], (string) $b['start']));
        return ['events' => array_slice($out, 0, $limit), 'truncated' => count($out) > $limit];
    }

    /** @return array<string, mixed> */
    public function event(string $uid, string $id): array
    {
        [$o, $vcal] = $this->object($uid, $id);
        if (!isset($vcal->VEVENT)) {
            throw new AtriumAgentError(404, "$id is not an event");
        }
        [$cal, $uri] = self::splitId($id);
        $master = null;
        $exceptions = [];
        foreach ($vcal->select('VEVENT') as $e) {
            if (isset($e->{'RECURRENCE-ID'})) {
                $exceptions[] = $this->eventView($cal, $uri, $e, null);
            } else {
                $master = $e;
            }
        }
        $view = $this->eventView($cal, $uri, $master ?? $vcal->VEVENT, $o['etag'] ?? null);
        $view['modified_occurrences'] = $exceptions;
        return $view;
    }

    private static function parseWhen(mixed $v, string $field, bool $allDay): \DateTimeImmutable
    {
        if (!is_string($v) || $v === '') {
            throw new \InvalidArgumentException("$field is required");
        }
        try {
            if ($allDay) {
                if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', substr($v, 0, 10))) {
                    throw new \Exception();
                }
                return new \DateTimeImmutable(substr($v, 0, 10), new \DateTimeZone('UTC'));
            }
            if (!preg_match('/(Z|[+-]\d{2}:?\d{2})$/', $v)) {
                throw new \InvalidArgumentException("$field needs a time zone offset (e.g. 2026-11-14T09:00:00+01:00 or ...Z)");
            }
            return (new \DateTimeImmutable($v))->setTimezone(new \DateTimeZone('UTC'));
        } catch (\InvalidArgumentException $e) {
            throw $e;
        } catch (\Throwable) {
            throw new \InvalidArgumentException("$field is not a date" . ($allDay ? ' (YYYY-MM-DD)' : ' (ISO 8601)'));
        }
    }

    private static function setDate(VEvent|VTodo $c, string $prop, \DateTimeImmutable $d, bool $allDay): void
    {
        unset($c->{$prop});
        $p = $c->add($prop, $d);
        if ($allDay) {
            $p['VALUE'] = 'DATE';
            $p->setDateTime($d, true);
        }
    }

    private static function checkRrule(string $rrule): string
    {
        $rrule = preg_replace('/^RRULE:/i', '', trim($rrule));
        if (!preg_match('/^FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Za-z0-9,+\-:]+)*$/', $rrule)) {
            throw new \InvalidArgumentException('rrule must be an iCalendar rule like FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10');
        }
        return $rrule;
    }

    /** @param array<string, mixed> $f */
    private function applyEvent(VEvent $e, array $f, bool $create): void
    {
        $allDay = array_key_exists('all_day', $f) ? (bool) $f['all_day'] : ($e->DTSTART !== null && !$e->DTSTART->hasTime());
        if (array_key_exists('title', $f)) {
            $t = trim((string) $f['title']);
            if ($t === '') {
                throw new \InvalidArgumentException('title must not be empty');
            }
            $e->SUMMARY = $t;
        }
        if ($create || array_key_exists('start', $f) || array_key_exists('all_day', $f)) {
            $start = self::parseWhen($f['start'] ?? self::dt($e->DTSTART), 'start', $allDay);
            $endIn = $f['end'] ?? null;
            if ($endIn === null && !$create && $e->DTEND !== null && !array_key_exists('all_day', $f)) {
                // Keep the duration when only the start moves.
                $old = \DateTimeImmutable::createFromInterface($e->DTSTART->getDateTime());
                $end = $start->add($old->diff(\DateTimeImmutable::createFromInterface($e->DTEND->getDateTime())));
            } else {
                $end = $endIn !== null ? self::parseWhen($endIn, 'end', $allDay) : $start->modify($allDay ? '+1 day' : '+1 hour');
            }
            if ($end <= $start) {
                throw new \InvalidArgumentException('end must be after start' . ($allDay ? ' (for all-day events end is the day after the last day)' : ''));
            }
            unset($e->DURATION);
            self::setDate($e, 'DTSTART', $start, $allDay);
            self::setDate($e, 'DTEND', $end, $allDay);
        } elseif (array_key_exists('end', $f)) {
            $end = self::parseWhen($f['end'], 'end', $allDay);
            if ($end <= \DateTimeImmutable::createFromInterface($e->DTSTART->getDateTime())) {
                throw new \InvalidArgumentException('end must be after start');
            }
            unset($e->DURATION);
            self::setDate($e, 'DTEND', $end, $allDay);
        }
        foreach (['location' => 'LOCATION', 'description' => 'DESCRIPTION'] as $k => $prop) {
            if (array_key_exists($k, $f)) {
                unset($e->{$prop});
                if ($f[$k] !== null && trim((string) $f[$k]) !== '') {
                    $e->{$prop} = (string) $f[$k];
                }
            }
        }
        if (array_key_exists('rrule', $f)) {
            unset($e->RRULE);
            if ($f['rrule'] !== null && $f['rrule'] !== '') {
                $e->RRULE = self::checkRrule((string) $f['rrule']);
            }
        }
    }

    private function save(int $calId, string $uri, VCalendar $vcal, bool $create): ?string
    {
        $etag = $create
            ? $this->backend->createCalendarObject($calId, $uri, $vcal->serialize())
            : $this->backend->updateCalendarObject($calId, $uri, $vcal->serialize());
        return is_string($etag) ? $etag : null;
    }

    private static function stamp(VEvent|VTodo $c): void
    {
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        unset($c->DTSTAMP, $c->{'LAST-MODIFIED'});
        $c->DTSTAMP = $now;
        $c->{'LAST-MODIFIED'} = $now;
        $seq = isset($c->SEQUENCE) ? (int) (string) $c->SEQUENCE : 0;
        $c->SEQUENCE = $seq + 1;
    }

    /** @param array<string, mixed> $f @return array<string, mixed> */
    public function createEvent(string $uid, ?string $calendarId, array $f): array
    {
        $calendarId ??= $this->defaultCalendar($uid, 'VEVENT');
        [$calId, , $c] = $this->calendar($uid, $calendarId, true);
        if (!$c['events']) {
            throw new \InvalidArgumentException("Calendar $calendarId does not take events");
        }
        $icalUid = strtoupper(bin2hex(random_bytes(16)));
        $vcal = new VCalendar(['PRODID' => '-//Atrium//Agent//EN']);
        $e = $vcal->add('VEVENT', ['UID' => $icalUid]);
        if (!array_key_exists('title', $f)) {
            throw new \InvalidArgumentException('title is required');
        }
        $this->applyEvent($e, $f, true);
        self::stamp($e);
        $uri = $icalUid . '.ics';
        $etag = $this->save($calId, $uri, $vcal, true);
        return $this->eventView($calendarId, $uri, $e, $etag);
    }

    /** @param array<string, mixed> $f @return array<string, mixed> */
    public function updateEvent(string $uid, string $id, array $f, ?string $etag): array
    {
        [$o, $vcal, $calId] = $this->object($uid, $id, true);
        if ($etag !== null && $etag !== '' && trim((string) $o['etag'], '"') !== trim($etag, '"')) {
            throw new AtriumAgentError(409, 'The event changed since you read it (etag)');
        }
        $master = null;
        foreach ($vcal->select('VEVENT') as $e) {
            if (!isset($e->{'RECURRENCE-ID'})) {
                $master = $e;
            }
        }
        if ($master === null) {
            throw new AtriumAgentError(404, "$id is not an event");
        }
        $this->applyEvent($master, $f, false);
        self::stamp($master);
        [$cal, $uri] = self::splitId($id);
        $newEtag = $this->save($calId, $uri, $vcal, false);
        return $this->eventView($cal, $uri, $master, $newEtag);
    }

    /** Moves the event or task to the calendar trash bin. @return array<string, mixed> */
    public function delete(string $uid, string $id, string $comp, ?string $etag = null): array
    {
        [$o, $vcal, $calId] = $this->object($uid, $id, true);
        if (!isset($vcal->{$comp})) {
            throw new AtriumAgentError(404, "$id is not " . ($comp === 'VTODO' ? 'a task' : 'an event'));
        }
        if ($etag !== null && $etag !== '' && trim((string) $o['etag'], '"') !== trim($etag, '"')) {
            throw new AtriumAgentError(409, 'It changed since the deletion was asked (etag)');
        }
        [, $uri] = self::splitId($id);
        $title = self::text($vcal->{$comp}->SUMMARY) ?? '';
        $this->backend->deleteCalendarObject($calId, $uri);
        return ['deleted' => true, 'title' => $title, 'trash' => true];
    }

    /** @return string|null the current etag, for approvals */
    public function etag(string $uid, string $id): ?string
    {
        return $this->object($uid, $id)[0]['etag'] ?? null;
    }

    /**
     * @return array{tasks: list<array<string, mixed>>, truncated: bool}
     */
    public function tasks(string $uid, ?string $calendarId, string $status, ?\DateTimeImmutable $dueBefore, ?string $query, int $limit = 100): array
    {
        $limit = max(1, min(self::MAX_ITEMS, $limit));
        $cals = $calendarId !== null ? [$this->calendar($uid, $calendarId)[2]] : array_filter($this->calendars($uid), fn($c) => $c['tasks']);
        $out = [];
        foreach ($cals as $c) {
            [$id, $type] = $this->calendar($uid, $c['calendar_id']);
            $uris = $this->backend->calendarQuery($id, self::filter('VTODO'), $type);
            foreach (array_chunk($uris, 100) as $chunk) {
                foreach ($this->backend->getMultipleCalendarObjects($id, $chunk, $type) as $o) {
                    $vcal = Reader::read($o['calendardata']);
                    if (!isset($vcal->VTODO)) {
                        continue;
                    }
                    $v = $this->taskView($c['calendar_id'], (string) $o['uri'], $vcal->VTODO, $o['etag'] ?? null);
                    if (($status === 'open' && $v['done']) || ($status === 'completed' && !$v['done'])) {
                        continue;
                    }
                    if ($dueBefore !== null && ($v['due'] === null || new \DateTimeImmutable($v['due']) >= $dueBefore)) {
                        continue;
                    }
                    if ($query !== null && $query !== '' && stripos($v['title'] . ' ' . ($v['description'] ?? ''), $query) === false) {
                        continue;
                    }
                    $v['calendar_name'] = $c['name'];
                    $out[] = $v;
                }
            }
        }
        // Due first (soonest), then the ones without a due date, by title.
        usort($out, fn($a, $b) => [$a['due'] === null, $a['due'], $a['title']] <=> [$b['due'] === null, $b['due'], $b['title']]);
        return ['tasks' => array_slice($out, 0, $limit), 'truncated' => count($out) > $limit];
    }

    /** @return array<string, mixed> */
    public function task(string $uid, string $id): array
    {
        [$o, $vcal] = $this->object($uid, $id);
        if (!isset($vcal->VTODO)) {
            throw new AtriumAgentError(404, "$id is not a task");
        }
        [$cal, $uri] = self::splitId($id);
        return $this->taskView($cal, $uri, $vcal->VTODO, $o['etag'] ?? null);
    }

    /** @param array<string, mixed> $f */
    private function applyTask(VTodo $t, array $f): void
    {
        if (array_key_exists('title', $f)) {
            $title = trim((string) $f['title']);
            if ($title === '') {
                throw new \InvalidArgumentException('title must not be empty');
            }
            $t->SUMMARY = $title;
        }
        foreach (['due' => 'DUE', 'start' => 'DTSTART'] as $k => $prop) {
            if (array_key_exists($k, $f)) {
                unset($t->{$prop});
                if ($f[$k] !== null && $f[$k] !== '') {
                    $allDay = is_string($f[$k]) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $f[$k]) === 1;
                    self::setDate($t, $prop, self::parseWhen($f[$k], $k, $allDay), $allDay);
                }
            }
        }
        if (array_key_exists('priority', $f)) {
            unset($t->PRIORITY);
            if ($f['priority'] !== null) {
                $p = (int) $f['priority'];
                if ($p < 0 || $p > 9) {
                    throw new \InvalidArgumentException('priority is 0-9 (1 = highest, 0 = none)');
                }
                if ($p > 0) {
                    $t->PRIORITY = $p;
                }
            }
        }
        if (array_key_exists('description', $f)) {
            unset($t->DESCRIPTION);
            if ($f['description'] !== null && trim((string) $f['description']) !== '') {
                $t->DESCRIPTION = (string) $f['description'];
            }
        }
        if (array_key_exists('categories', $f)) {
            unset($t->CATEGORIES);
            $cats = array_values(array_filter(array_map('strval', (array) ($f['categories'] ?? [])), fn($s) => trim($s) !== ''));
            if ($cats) {
                $t->CATEGORIES = $cats;
            }
        }
        if (array_key_exists('done', $f)) {
            self::complete($t, (bool) $f['done']);
        }
    }

    private static function complete(VTodo $t, bool $done): void
    {
        unset($t->COMPLETED);
        if ($done) {
            $t->STATUS = 'COMPLETED';
            $t->{'PERCENT-COMPLETE'} = 100;
            $t->COMPLETED = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        } else {
            $t->STATUS = 'NEEDS-ACTION';
            unset($t->{'PERCENT-COMPLETE'});
        }
    }

    /** @param array<string, mixed> $f @return array<string, mixed> */
    public function createTask(string $uid, ?string $calendarId, array $f, ?string $parentId): array
    {
        $parentUid = null;
        if ($parentId !== null) {
            $parent = $this->task($uid, $parentId);
            $parentUid = $parent['uid'];
            $calendarId ??= $parent['calendar_id'];
        }
        $calendarId ??= $this->defaultCalendar($uid, 'VTODO');
        [$calId, , $c] = $this->calendar($uid, $calendarId, true);
        if (!$c['tasks']) {
            throw new \InvalidArgumentException("Calendar $calendarId does not take tasks");
        }
        if (!array_key_exists('title', $f)) {
            throw new \InvalidArgumentException('title is required');
        }
        $icalUid = strtoupper(bin2hex(random_bytes(16)));
        $vcal = new VCalendar(['PRODID' => '-//Atrium//Agent//EN']);
        $t = $vcal->add('VTODO', ['UID' => $icalUid]);
        $t->STATUS = 'NEEDS-ACTION';
        if ($parentUid !== null) {
            $t->add('RELATED-TO', $parentUid, ['RELTYPE' => 'PARENT']);
        }
        $this->applyTask($t, $f);
        self::stamp($t);
        $uri = $icalUid . '.ics';
        $etag = $this->save($calId, $uri, $vcal, true);
        return $this->taskView($calendarId, $uri, $t, $etag);
    }

    /** @param array<string, mixed> $f @return array<string, mixed> */
    public function updateTask(string $uid, string $id, array $f, ?string $etag): array
    {
        [$o, $vcal, $calId] = $this->object($uid, $id, true);
        if (!isset($vcal->VTODO)) {
            throw new AtriumAgentError(404, "$id is not a task");
        }
        if ($etag !== null && $etag !== '' && trim((string) $o['etag'], '"') !== trim($etag, '"')) {
            throw new AtriumAgentError(409, 'The task changed since you read it (etag)');
        }
        $this->applyTask($vcal->VTODO, $f);
        self::stamp($vcal->VTODO);
        [$cal, $uri] = self::splitId($id);
        $newEtag = $this->save($calId, $uri, $vcal, false);
        return $this->taskView($cal, $uri, $vcal->VTODO, $newEtag);
    }
}

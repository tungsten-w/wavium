<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Service;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use OCP\IGroupManager;
use OCP\IUserManager;

final class BoardService
{
    private const DEFAULT_TEMPLATE = [
        '☀️ plan the day',
        '↳ 🗓️ check the calendar',
        '---',
        '__DAY_ITEMS__',
        '---',
        '🚶 take a walk',
        '📝 daily review',
    ];

    public function __construct(private IDBConnection $db, private IGroupManager $groups, private CalDavAdapter $dav, private IUserManager $users, private ActivityPublisher $activity, private ?AgentEvents $events = null) {}
    private function one(string $table, array $where): ?array
    {
        $q = $this->db->getQueryBuilder();
        $q->select('*')->from($table);
        foreach ($where as $k => $v) {
            $q->andWhere($q->expr()->eq($k, $q->createNamedParameter($v)));
        }$r = $q->executeQuery()->fetchAssociative();
        return $r ?: null;
    }
    private function board(string $uid, bool $create = true): array
    {
        $b = $this->one('daily_todo_boards', ['owner_uid' => $uid]);
        if (!$b && $create) {
            $tz = date_default_timezone_get();
            $q = $this->db->getQueryBuilder();
            $q->insert('daily_todo_boards')->values(['owner_uid' => $q->createNamedParameter($uid),'timezone' => $q->createNamedParameter($tz),'rollover_hour' => $q->createNamedParameter(3, IQueryBuilder::PARAM_INT),'rollover_mode' => $q->createNamedParameter('all'),'task_lists' => $q->createNamedParameter('[]'),'calendars' => $q->createNamedParameter('[]')]);
            try {
                $q->executeStatement();
            } catch (\OCP\DB\Exception $e) {
                // A first visit fires several requests at once; another one created the board first.
                if ($e->getReason() !== \OCP\DB\Exception::REASON_UNIQUE_CONSTRAINT_VIOLATION) {
                    throw $e;
                }
            }
            $b = $this->one('daily_todo_boards', ['owner_uid' => $uid]);
        }return $b ?? throw new \RuntimeException('Board not found');
    }
    public function accessibleBoard(string $actor, ?string $owner = null): array
    {
        $b = $this->board($owner ?: $actor, $owner === null || $owner === $actor);
        if ($b['owner_uid'] === $actor) {
            return $b;
        }$q = $this->db->getQueryBuilder();
        $q->select('*')->from('daily_todo_shares')->where($q->expr()->eq('board_id', $q->createNamedParameter($b['id'])));
        foreach ($q->executeQuery()->fetchAllAssociative() as $s) {
            if ($s['share_type'] === 'user' && $s['share_with'] === $actor) {
                return $b;
            }if ($s['share_type'] === 'group' && $this->groups->isInGroup($actor, $s['share_with'])) {
                return $b;
            }
        }throw new \RuntimeException('Board access denied');
    }
    public function settings(string $actor, ?string $owner = null): array
    {
        $b = $this->accessibleBoard($actor, $owner);
        return ['owner' => $b['owner_uid'],'timezone' => $b['timezone'],'rolloverHour' => (int) $b['rollover_hour'],'rolloverMode' => $b['rollover_mode'],'completeSubtasks' => (bool) $b['complete_subtasks'],'taskLists' => json_decode($b['task_lists'], true) ?: [],'calendars' => json_decode($b['calendars'], true) ?: [],'publicItems' => self::decodeTitles($b['public_items'] ?? null),'isOwner' => $b['owner_uid'] === $actor];
    }
    public function saveSettings(string $actor, array $data): array
    {
        $b = $this->accessibleBoard($actor);
        if ($b['owner_uid'] !== $actor) {
            throw new \RuntimeException('Only the owner may change settings');
        }$hour = max(0, min(23, (int) ($data['rolloverHour'] ?? 3)));
        $mode = in_array($data['rolloverMode'] ?? '', ['quick_only','all','none'], true) ? $data['rolloverMode'] : 'quick_only';
        $tz = new \DateTimeZone((string) ($data['timezone'] ?? 'UTC'));
        $q = $this->db->getQueryBuilder();
        $q->update('daily_todo_boards')->set('timezone', $q->createNamedParameter($tz->getName()))->set('rollover_hour', $q->createNamedParameter($hour, IQueryBuilder::PARAM_INT))->set('rollover_mode', $q->createNamedParameter($mode))->set('complete_subtasks', $q->createNamedParameter((bool) ($data['completeSubtasks'] ?? false), IQueryBuilder::PARAM_BOOL))->set('task_lists', $q->createNamedParameter(json_encode(array_values($data['taskLists'] ?? []))))->set('calendars', $q->createNamedParameter(json_encode(array_values($data['calendars'] ?? []))))->where($q->expr()->eq('id', $q->createNamedParameter($b['id'])))->executeStatement();
        if (isset($data['publicItems']) && is_array($data['publicItems'])) {
            $p = $this->db->getQueryBuilder();
            $p->update('daily_todo_boards')->set('public_items', $p->createNamedParameter(json_encode(self::normalizeTitles($data['publicItems']), JSON_UNESCAPED_UNICODE)))->where($p->expr()->eq('id', $p->createNamedParameter($b['id'])))->executeStatement();
        }
        return $this->settings($actor);
    }
    public function sources(string $actor): array
    {
        $b = $this->accessibleBoard($actor);
        if ($b['owner_uid'] !== $actor) {
            throw new \RuntimeException('Only the owner may inspect sources');
        }return $this->dav->sources($actor);
    }
    private function dayRow(array $b, string $day): array
    {
        $r = $this->one('daily_todo_days', ['board_id' => $b['id'],'day' => $day]);
        if (!$r) {
            $q = $this->db->getQueryBuilder();
            $q->insert('daily_todo_days')->values(['board_id' => $q->createNamedParameter($b['id']),'day' => $q->createNamedParameter($day),'frozen' => $q->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),'updated_at' => $q->createNamedParameter(time(), IQueryBuilder::PARAM_INT)])->executeStatement();
            $r = $this->one('daily_todo_days', ['board_id' => $b['id'],'day' => $day]);
        }return $r;
    }
    private function rows(string $table, array $where, string $order = 'id'): array
    {
        $q = $this->db->getQueryBuilder();
        $q->select('*')->from($table);
        foreach ($where as $k => $v) {
            $q->andWhere($q->expr()->eq($k, $q->createNamedParameter($v)));
        }$q->orderBy($order, 'ASC');
        return $q->executeQuery()->fetchAllAssociative();
    }
    public function getDay(string $actor, string $day, ?string $owner = null): array
    {
        $b = $this->accessibleBoard($actor, $owner);
        $this->ensureDefaultTemplate($b);
        $logical = LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']);
        $d = $this->one('daily_todo_days', ['board_id' => $b['id'], 'day' => $day]);
        $future = $day > $logical;
        if (!$d && $day !== $logical) {
            // A day is only created when it starts: neither history nor the future is generated.
            return ['day' => $day,'logicalToday' => $logical,'editable' => false,'future' => $future,'owner' => $b['owner_uid'],'isOwner' => $b['owner_uid'] === $actor,'items' => [],'completeSubtasks' => (bool) $b['complete_subtasks'],'version' => $this->fingerprint($b, null, $logical)];
        }
        $d ??= $this->dayRow($b, $day);
        if (!$future && !$d['frozen']) {
            $this->reconcile($b, $d, $day);
        }$items = $this->rows('daily_todo_items', ['day_id' => $d['id']], 'position');
        foreach ($items as &$i) {
            $i['id'] = (int) $i['id'];
            $i['completed'] = (bool) $i['completed'];
            $i['all_day'] = (bool) $i['all_day'];
            $i['parent_id'] = $i['parent_id'] === null ? null : (int) $i['parent_id'];
        }$editable = LogicalDate::editable($day, $logical);
        return ['day' => $day,'logicalToday' => $logical,'editable' => $editable,'future' => $future,'owner' => $b['owner_uid'],'isOwner' => $b['owner_uid'] === $actor,'items' => $items,'completeSubtasks' => (bool) $b['complete_subtasks'],'version' => $this->fingerprint($b, $d, $logical)];
    }
    /**
     * A cheap "has anything changed?" check for the open day: only the version, no list.
     * It runs a few small queries and no calendar parsing, so clients can ask often and
     * fetch the day itself only when the version moves.
     *
     * @return array{version: string}
     */
    public function dayVersion(string $actor, string $day, ?string $owner = null): array
    {
        $b = $this->accessibleBoard($actor, $owner);
        $logical = LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']);
        $d = $this->one('daily_todo_days', ['board_id' => $b['id'], 'day' => $day]);

        return ['version' => $this->fingerprint($b, $d, $logical)];
    }

    /**
     * Everything that decides what a day shows: the board's settings and template, the day's
     * stored items, and the change counter (sync token) of each enabled Tasks/Calendar list,
     * which Nextcloud bumps whenever anything in that list is created, edited or deleted.
     */
    private function fingerprint(array $b, ?array $d, string $logical): string
    {
        $lists = array_values(array_unique(array_merge(
            json_decode($b['task_lists'], true) ?: [],
            json_decode($b['calendars'], true) ?: [],
        )));
        $tokens = [];
        if ($lists) {
            $q = $this->db->getQueryBuilder();
            $q->select('id', 'synctoken')->from('calendars')
                ->where($q->expr()->in('id', $q->createNamedParameter(array_map('intval', $lists), IQueryBuilder::PARAM_INT_ARRAY)))
                ->orderBy('id');
            $tokens = $q->executeQuery()->fetchAllAssociative();
        }

        return sha1(json_encode([
            $logical,
            [$b['timezone'], $b['rollover_hour'], $b['rollover_mode'], $b['task_lists'], $b['calendars'], $b['complete_subtasks']],
            $tokens,
            $d ? [$d['id'], $d['frozen']] : null,
            $d ? $this->rows('daily_todo_items', ['day_id' => $d['id']], 'position') : [],
            $this->rows('daily_todo_templates', ['board_id' => $b['id']], 'position'),
        ]));
    }

    /**
     * Completion per recorded day of a month (YYYY-MM), for the calendar.
     * Only days that were created are present (the calendar grays the others);
     * separators are not counted.
     *
     * @return array<string, array{total: int, done: int}>
     */
    public function summary(string $actor, string $month, ?string $owner = null): array
    {
        if (preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month) !== 1) {
            throw new \RuntimeException('Invalid month');
        }
        $b = $this->accessibleBoard($actor, $owner);

        return $this->completionBetween($b, $month . '-01', $month . '-31');
    }

    /**
     * Item titles as matched by the public status: trimmed, a leading "↳" dropped, blanks and
     * duplicates removed.
     *
     * @param array<mixed> $titles
     * @return list<string>
     */
    public static function normalizeTitles(array $titles): array
    {
        $norm = static fn($t): string => trim((string) preg_replace('/^\s*↳/u', '', trim((string) $t)));
        return array_values(array_unique(array_filter(array_map($norm, $titles), fn($t) => $t !== '')));
    }

    /** @return list<string> The titles stored on a board (Settings → Public status). */
    public static function decodeTitles(?string $json): array
    {
        $stored = $json === null ? null : json_decode($json, true);
        return is_array($stored) && array_is_list($stored) ? self::normalizeTitles($stored) : [];
    }

    /**
     * Unauthenticated, read-only: whether the items the owner made public are all ticked today
     * (moonmelon stays grayscale until "📚 study" and "💾 anki" are done). Only those titles are
     * ever looked at. It never creates the day, so a day that is not built yet reads as not done;
     * an item missing today counts as not done. A list with nothing public does not exist here.
     *
     * @return array{day: string, done: bool, items: array<string, bool|null>}
     */
    public function publicStatus(string $owner): array
    {
        $b = $this->one('daily_todo_boards', ['owner_uid' => $owner]);
        $titles = $b ? self::decodeTitles($b['public_items'] ?? null) : [];
        if ($titles === []) {
            throw new PublicStatusNotFound('Not found');
        }
        $logical = LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']);
        $rows = [];
        $d = $this->one('daily_todo_days', ['board_id' => $b['id'], 'day' => $logical]);
        if ($d) {
            $q = $this->db->getQueryBuilder();
            $q->select('title', 'completed')->from('daily_todo_items')->where($q->expr()->eq('day_id', $q->createNamedParameter($d['id'])));
            $rows = $q->executeQuery()->fetchAllAssociative();
        }

        return self::summarisePublic($titles, $rows, $logical);
    }

    /**
     * Pure part of publicStatus: match the day's item rows against the public titles.
     *
     * @param list<string> $titles
     * @param list<array{title: mixed, completed: mixed}> $rows
     * @return array{day: string, done: bool, items: array<string, bool|null>}
     */
    public static function summarisePublic(array $titles, array $rows, string $logical): array
    {
        $items = array_fill_keys($titles, null);
        foreach ($rows as $row) {
            $t = self::normalizeTitles([$row['title']])[0] ?? '';
            if (array_key_exists($t, $items)) {
                // The same title twice on a day counts as done only when every copy is.
                $items[$t] = ($items[$t] ?? true) && (bool) $row['completed'];
            }
        }

        return ['day' => $logical, 'done' => $items !== [] && !in_array(null, $items, true) && !in_array(false, $items, true), 'items' => $items];
    }

    /**
     * Completion per recorded day between two dates (YYYY-MM-DD, inclusive) of your own list,
     * at most a year, for the Stats page. Same shape and rules as `summary()`.
     *
     * @return array<string, array{total: int, done: int}>
     */
    public function stats(string $actor, string $from, string $to): array
    {
        foreach ([$from, $to] as $date) {
            if (!CalDavAdapter::isDay($date)) {
                throw new \RuntimeException('Invalid date');
            }
        }
        if ($to < $from || (new \DateTimeImmutable($to))->diff(new \DateTimeImmutable($from))->days > 366) {
            throw new \RuntimeException('Invalid range');
        }

        return $this->completionBetween($this->accessibleBoard($actor), $from, $to);
    }

    private function completionBetween(array $b, string $from, string $to): array
    {
        $q = $this->db->getQueryBuilder();
        $q->select('id', 'day')->from('daily_todo_days')
            ->where($q->expr()->eq('board_id', $q->createNamedParameter($b['id'])))
            ->andWhere($q->expr()->gte('day', $q->createNamedParameter($from)))
            ->andWhere($q->expr()->lte('day', $q->createNamedParameter($to)));
        $out = [];
        $byId = [];
        foreach ($q->executeQuery()->fetchAllAssociative() as $row) {
            $out[$row['day']] = ['total' => 0, 'done' => 0];
            $byId[(int) $row['id']] = $row['day'];
        }
        if (!$byId) {
            return $out;
        }
        $q = $this->db->getQueryBuilder();
        $q->select('day_id', 'title', 'completed')->from('daily_todo_items')
            ->where($q->expr()->in('day_id', $q->createNamedParameter(array_keys($byId), IQueryBuilder::PARAM_INT_ARRAY)));
        foreach ($q->executeQuery()->fetchAllAssociative() as $item) {
            if (EntryTree::separator((string) $item['title']) !== null) {
                continue;
            }
            $day = $byId[(int) $item['day_id']];
            $out[$day]['total']++;
            if ($item['completed']) {
                $out[$day]['done']++;
            }
        }

        return $out;
    }

    private function reconcile(array $b, array $d, string $day, bool $includeOverdue = false): void
    {
        $existing = $this->rows('daily_todo_items', ['day_id' => $d['id']], 'position');
        $ids = [];
        $rowsByKey = [];
        $max = -1;
        foreach ($existing as $e) {
            $key = $e['source_type'] . ':' . $e['source_id'];
            $ids[$key] = (int) $e['id'];
            $rowsByKey[$key] = $e;
            $max = max($max, (int) $e['position']);
        }
        $dayEntries = EntryTree::order($this->dav->entries($b['owner_uid'], $day, json_decode($b['task_lists'], true) ?: [], json_decode($b['calendars'], true) ?: [], $includeOverdue));
        $tpl = $this->rows('daily_todo_templates', ['board_id' => $b['id']], 'position');
        $split = null;
        foreach ($tpl as $t) {
            if ($t['title'] === '__DAY_ITEMS__') {
                $split = (int) $t['position'];
            }
        }
        $split ??= PHP_INT_MAX;
        $morning = [];
        $evening = [];
        $parentKey = null;
        $lastSide = null;
        foreach ($tpl as $t) {
            if ($t['title'] === '__DAY_ITEMS__') {
                continue;
            }
            $side = (int) $t['position'] < $split ? 'morning' : 'evening';
            [$title, $isSub] = EntryTree::splitSubItem((string) $t['title']);
            if ($side !== $lastSide || !$isSub) {
                $parentKey = null;
            }
            $lastSide = $side;
            $e = ['source_type' => 'routine','source_id' => 'routine:' . $t['id'],'title' => $title,'starts_at' => null,'due_at' => null,'all_day' => false,'completed' => false,'href' => null,'parent_key' => $isSub ? $parentKey : null];
            if (!$isSub && EntryTree::separator($title) === null) {
                $parentKey = EntryTree::key($e);
            }
            if ($side === 'morning') {
                $morning[] = $e;
            } else {
                $evening[] = $e;
            }
        }
        $wanted = [];
        foreach (array_merge($morning, $dayEntries, $evening) as $e) {
            $key = EntryTree::key($e);
            $wanted[$key] = true;
            $parentId = isset($e['parent_key']) ? ($ids[$e['parent_key']] ?? null) : null;
            if (isset($ids[$key])) {
                // Keep existing items in step with their source: nesting always, and the
                // title for routines unless renamed for this day (other titles are never rewritten).
                $row = $rowsByKey[$key];
                $currentParent = $row['parent_id'] === null ? null : (int) $row['parent_id'];
                $title = $e['source_type'] === 'routine' && !$row['title_locked'] ? $e['title'] : $row['title'];
                if ($currentParent !== $parentId || $title !== $row['title']) {
                    $q = $this->db->getQueryBuilder();
                    $q->update('daily_todo_items')->set('parent_id', $q->createNamedParameter($parentId, IQueryBuilder::PARAM_INT))->set('title', $q->createNamedParameter($title))->where($q->expr()->eq('id', $q->createNamedParameter($ids[$key])))->executeStatement();
                }
                continue;
            }
            if ($existing && $e['source_type'] !== 'routine') {
                // A task or event that shows up after the day was first built (a new task, or
                // sources enabled later) goes into the template's "Day items" slot, not the end.
                $position = $this->quickInsertPosition($b, $d);
                $this->shiftPositions((int) $d['id'], $position);
                $max++;
                $ids[$key] = $this->insertItem($d['id'], $e, $position, $parentId);
                continue;
            }
            $ids[$key] = $this->insertItem($d['id'], $e, ++$max, $parentId);
        }
        // A routine removed from the template disappears from days that are still open.
        foreach ($rowsByKey as $key => $row) {
            $removedRoutine = $row['source_type'] === 'routine' && !isset($wanted[$key]);
            $movedEvent = $row['source_type'] === 'event' && !$row['completed']
                && !isset($wanted[$key])
                && $this->dav->eventMovedOffDay((string) $row['source_id'], $day);
            if ($removedRoutine || $movedEvent) {
                // Keep any user-created children, detached from the removed source item.
                $q = $this->db->getQueryBuilder();
                $q->update('daily_todo_items')->set('parent_id', $q->createNamedParameter(null))
                    ->where($q->expr()->eq('day_id', $q->createNamedParameter((int) $d['id'])))
                    ->andWhere($q->expr()->eq('parent_id', $q->createNamedParameter((int) $row['id'])))->executeStatement();
                $q = $this->db->getQueryBuilder();
                $q->delete('daily_todo_items')->where($q->expr()->eq('id', $q->createNamedParameter((int) $row['id'])))->executeStatement();
            }
        }
        $this->placePostponed($b, $d, $day);
    }
    private function insertItem(int|string $dayId, array $e, int $position, ?int $parentId = null): int
    {
        $q = $this->db->getQueryBuilder();
        $q->insert('daily_todo_items')->values(['day_id' => $q->createNamedParameter($dayId),'source_type' => $q->createNamedParameter($e['source_type']),'source_id' => $q->createNamedParameter($e['source_id'] ?? null),'title' => $q->createNamedParameter($e['title']),'starts_at' => $q->createNamedParameter($e['starts_at'] ?? null),'due_at' => $q->createNamedParameter($e['due_at'] ?? null),'all_day' => $q->createNamedParameter((bool) ($e['all_day'] ?? false), IQueryBuilder::PARAM_BOOL),'completed' => $q->createNamedParameter((bool) ($e['completed'] ?? false), IQueryBuilder::PARAM_BOOL),'position' => $q->createNamedParameter($position, IQueryBuilder::PARAM_INT),'href' => $q->createNamedParameter($e['href'] ?? null),'parent_id' => $q->createNamedParameter($parentId, IQueryBuilder::PARAM_INT)])->executeStatement();
        return (int) $this->db->lastInsertId('daily_todo_items');
    }
    private function itemForActor(string $actor, int $id): array
    {
        $i = $this->one('daily_todo_items', ['id' => $id]) ?? throw new \RuntimeException('Item not found');
        $d = $this->one('daily_todo_days', ['id' => $i['day_id']]);
        $b = $this->one('daily_todo_boards', ['id' => $d['board_id']]);
        $this->accessibleBoard($actor, $b['owner_uid']);
        $today = LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']);
        if (!LogicalDate::editable($d['day'], $today)) {
            throw new \RuntimeException('Historical days are read-only');
        }return [$i,$d,$b];
    }
    public function complete(string $actor, int $id, bool $done): void
    {
        [$i, $d, $b] = $this->itemForActor($actor, $id);
        // Subtasks are independent by default. With the board's "complete subtasks" setting on,
        // ticking a parent ticks everything below it (like the Tasks app); un-ticking never cascades.
        $targets = [$i];
        if ($done && $b['complete_subtasks']) {
            $targets = array_merge($targets, $this->descendants((int) $i['day_id'], $id));
        }
        foreach ($targets as $target) {
            if ($target['source_type'] === 'task') {
                $this->dav->setTaskCompleted($target['source_id'], $done);
            }
            $q = $this->db->getQueryBuilder();
            $q->update('daily_todo_items')->set('completed', $q->createNamedParameter($done, IQueryBuilder::PARAM_BOOL))->set('error', $q->createNamedParameter(null))->where($q->expr()->eq('id', $q->createNamedParameter((int) $target['id'])))->executeStatement();
        }
        if ($done && !$i['completed'] && $i['source_type'] !== 'task' && EntryTree::separator((string) $i['title']) === null) {
            $this->activity->itemCompleted($actor, (string) $b['owner_uid'], (string) $i['title']);
        }
        if ((bool) $i['completed'] !== $done && EntryTree::separator((string) $i['title']) === null) {
            $this->events?->emit($done ? 'todo.item.completed' : 'todo.item.uncompleted', (string) $b['owner_uid'], $actor, [
                'item_id' => $id, 'day' => (string) $d['day'], 'title' => (string) $i['title'], 'kind' => (string) $i['source_type'],
                'cascaded' => array_map(fn($t) => (int) $t['id'], array_slice($targets, 1)),
            ]);
        }
        if ($done && $this->dayIsFinished((int) $d['id'])) {
            $this->activity->dayFinished($actor, (string) $b['owner_uid'], (string) $d['day']);
            $this->events?->emit('todo.day.finished', (string) $b['owner_uid'], $actor, ['day' => (string) $d['day']]);
        }
    }
    /** Everything on the day is ticked (dividers and gaps do not count), and there is something. */
    private function dayIsFinished(int $dayId): bool
    {
        $total = 0;
        foreach ($this->rows('daily_todo_items', ['day_id' => $dayId]) as $row) {
            if (EntryTree::separator((string) $row['title']) !== null) {
                continue;
            }
            if (!$row['completed']) {
                return false;
            }
            $total++;
        }

        return $total > 0;
    }
    /**
     * All items below $id on the same day, nearest first.
     *
     * @return list<array<string, mixed>>
     */
    private function descendants(int $dayId, int $id): array
    {
        $byParent = [];
        foreach ($this->rows('daily_todo_items', ['day_id' => $dayId], 'position') as $row) {
            if ($row['parent_id'] !== null) {
                $byParent[(int) $row['parent_id']][] = $row;
            }
        }
        $out = [];
        $queue = [$id];
        $seen = [$id => true];
        while ($queue) {
            foreach ($byParent[array_shift($queue)] ?? [] as $child) {
                if (!isset($seen[(int) $child['id']])) {
                    $seen[(int) $child['id']] = true;
                    $out[] = $child;
                    $queue[] = (int) $child['id'];
                }
            }
        }

        return $out;
    }

    public function reorder(string $actor, string $day, array $ids, ?string $owner = null): void
    {
        $b = $this->accessibleBoard($actor, $owner);
        $this->assertEditable($b, $day);
        $d = $this->dayRow($b, $day);
        foreach (array_values($ids) as $p => $id) {
            $q = $this->db->getQueryBuilder();
            $q->update('daily_todo_items')->set('position', $q->createNamedParameter($p, IQueryBuilder::PARAM_INT))->where($q->expr()->eq('id', $q->createNamedParameter((int) $id)))->andWhere($q->expr()->eq('day_id', $q->createNamedParameter($d['id'])))->executeStatement();
        }
        $this->events?->emit('todo.day.reordered', (string) $b['owner_uid'], $actor, ['day' => $day, 'item_ids' => array_map('intval', array_values($ids))]);
    }
    public function createQuick(string $actor, string $day, string $title, ?string $owner = null, ?int $parentId = null, ?int $afterId = null): int
    {
        $id = $this->insertQuick($actor, $day, $title, $owner, $parentId, $afterId);
        $this->activity->itemAdded($actor, $owner ?? $actor, trim($title) ?: 'New item');
        $this->events?->emit('todo.item.created', $owner ?? $actor, $actor, [
            'item_id' => $id, 'day' => $day, 'title' => trim($title) ?: 'New item', 'kind' => 'quick', 'parent_id' => $parentId,
        ]);

        return $id;
    }
    private function insertQuick(string $actor, string $day, string $title, ?string $owner, ?int $parentId, ?int $afterId): int
    {
        $b = $this->accessibleBoard($actor, $owner);
        $this->assertEditable($b, $day);
        // API clients can add the first item before anyone opens the day. Build the
        // template and sources first so its Day items slot already has boundaries.
        $this->ensureDefaultTemplate($b);
        $d = $this->dayRow($b, $day);
        if (!$d['frozen']) {
            $this->reconcile($b, $d, $day);
        }
        if ($parentId !== null && $afterId === null) {
            $parent = $this->one('daily_todo_items', ['id' => $parentId, 'day_id' => $d['id']]) ?? throw new \RuntimeException('Parent item not found');
            // Checklists are one level deep, like in the Tasks app UI.
            $parentId = $parent['parent_id'] === null ? (int) $parent['id'] : (int) $parent['parent_id'];
        }
        $item = ['source_type' => 'quick','source_id' => bin2hex(random_bytes(12)),'title' => trim($title) ?: 'New item'];
        if ($afterId !== null) {
            // Edit mode: insert right after a given item (and its subitems); 0 means the very top.
            // After a subitem, the new item becomes a sibling subitem.
            $newParent = null;
            $position = 0;
            if ($afterId !== 0) {
                $anchor = $this->one('daily_todo_items', ['id' => $afterId, 'day_id' => $d['id']]) ?? throw new \RuntimeException('Item not found');
                $block = array_merge([$anchor], $this->descendants((int) $d['id'], (int) $anchor['id']));
                $position = max(array_map(fn($r) => (int) $r['position'], $block)) + 1;
                $newParent = $anchor['parent_id'] === null ? null : (int) $anchor['parent_id'];
            }
            $this->shiftPositions((int) $d['id'], $position);
            return $this->insertItem($d['id'], $item, $position, $newParent);
        }
        if ($parentId !== null) {
            $parent = $this->one('daily_todo_items', ['id' => $parentId, 'day_id' => $d['id']]) ?? throw new \RuntimeException('Parent item not found');
            $block = array_merge([$parent], $this->descendants((int) $d['id'], $parentId));
            $position = max(array_map(fn($row) => (int) $row['position'], $block)) + 1;
            $this->shiftPositions((int) $d['id'], $position);
            return $this->insertItem($d['id'], $item, $position, $parentId);
        }
        // A new item goes where the day's tasks and events are, not below the evening routines.
        $position = $this->quickInsertPosition($b, $d);
        $this->shiftPositions((int) $d['id'], $position);
        return $this->insertItem($d['id'], $item, $position);
    }

    /** Make room: move every item at or after $from $by positions down. */
    private function shiftPositions(int $dayId, int $from, int $by = 1): void
    {
        $q = $this->db->getQueryBuilder();
        $q->update('daily_todo_items')->set('position', $q->func()->add('position', $q->createNamedParameter($by, IQueryBuilder::PARAM_INT)))->where($q->expr()->eq('day_id', $q->createNamedParameter($dayId)))->andWhere($q->expr()->gte('position', $q->createNamedParameter($from, IQueryBuilder::PARAM_INT)))->executeStatement();
    }
    /**
     * End of the Day items slot, immediately before the first evening routine.
     * A day item moved above a morning routine must not pull this anchor upwards.
     */
    private function quickInsertPosition(array $b, array $d): int
    {
        $template = $this->rows('daily_todo_templates', ['board_id' => $b['id']], 'position');
        $split = null;
        foreach ($template as $t) {
            if ($t['title'] === '__DAY_ITEMS__') {
                $split = (int) $t['position'];
            }
        }
        $evening = [];
        foreach ($template as $t) {
            if ($split !== null && $t['title'] !== '__DAY_ITEMS__' && (int) $t['position'] > $split) {
                $evening['routine:' . $t['id']] = true;
            }
        }
        $items = $this->rows('daily_todo_items', ['day_id' => $d['id']], 'position');
        $position = 0;
        foreach ($items as $i) {
            if ($i['source_type'] === 'routine' && isset($evening[$i['source_id']])) {
                return (int) $i['position'];
            }
            $position = max($position, (int) $i['position'] + 1);
        }
        return $position;
    }

    private function assertEditable(array $b, string $day): void
    {
        if (!LogicalDate::editable($day, LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']))) {
            throw new \RuntimeException('This day is read-only');
        }
    }
    /**
     * Rename an item. Your own items and routine items change for that day only;
     * a task is renamed in Tasks too. Calendar events and dividers cannot be renamed.
     */
    public function rename(string $actor, int $id, string $title): void
    {
        [$i, $d, $b] = $this->itemForActor($actor, $id);
        $title = trim($title);
        if ($title === '') {
            throw new \RuntimeException('A title is required');
        }
        if (!in_array($i['source_type'], ['quick', 'routine', 'task'], true) || EntryTree::separator((string) $i['title']) !== null) {
            throw new \RuntimeException('This item cannot be renamed here');
        }
        if ($i['source_type'] === 'task') {
            $this->dav->setTaskTitle($i['source_id'], $title);
        }
        $q = $this->db->getQueryBuilder();
        $q->update('daily_todo_items')->set('title', $q->createNamedParameter($title));
        if ($i['source_type'] === 'routine') {
            $q->set('title_locked', $q->createNamedParameter(true, IQueryBuilder::PARAM_BOOL));
        }
        $q->where($q->expr()->eq('id', $q->createNamedParameter($id)))->executeStatement();
        $this->events?->emit('todo.item.renamed', (string) $b['owner_uid'], $actor, [
            'item_id' => $id, 'day' => (string) $d['day'], 'title' => $title, 'old_title' => (string) $i['title'], 'kind' => (string) $i['source_type'],
        ]);
    }
    /**
     * Delete a quick item or trash a real task tree in Tasks. Returns the id of a short-lived copy
     * ("trash") that `restore()` puts back, which is what the Undo button uses.
     */
    public function deleteQuick(string $actor, int $id): int
    {
        [$i, $d, $b] = $this->itemForActor($actor, $id);
        if (!in_array($i['source_type'], ['quick', 'task'], true)) {
            throw new \RuntimeException('Only tasks and quick items can be deleted');
        }
        $this->purgeTrash();
        $this->db->beginTransaction();
        try {
            $copies = $i['source_type'] === 'task'
                ? $this->dav->trashTask((string) $b['owner_uid'], (string) $i['source_id'], json_decode($b['task_lists'], true) ?: []) : [];
            $block = $this->takeBlock($i);
            $block['title'] = (string) $i['title'];
            if ($copies) {
                $block['deleted_tasks'] = $copies;
                $block['root_task'] = (string) $i['source_id'];
            }
            $trash = $this->trash((int) $d['board_id'], (string) $d['day'], null, $block);
            $this->db->commit();
        } catch (\Throwable $error) {
            $this->db->rollBack();
            throw $error;
        }
        $this->activity->itemDeleted($actor, (string) $b['owner_uid'], (string) $i['title']);
        $this->events?->emit('todo.item.deleted', (string) $b['owner_uid'], $actor, [
            'item_id' => $id, 'day' => (string) $d['day'], 'title' => (string) $i['title'], 'kind' => (string) $i['source_type'], 'trash_id' => $trash,
        ]);

        return $trash;
    }

    /**
     * Postpone an item of today for 1-365 days. Those days do not exist yet and are never
     * generated early.
     *
     * - A quick item (with its quick subtasks) leaves the day and waits in the trash table; it is
     *   placed on its day when that day starts.
     * - A task moves in Tasks itself: its start and due dates are shifted, so it is placed on the
     *   new day like any task with that date, in Tasks as well as here. Repeating tasks, finished
     *   tasks and subtasks (which follow their parent) are refused.
     *
     * @return array{trash: int, due: string} the undo copy, and the date the item comes back
     */
    public function postpone(string $actor, int $id, int $days = 1): array
    {
        if ($days < 1 || $days > 365) {
            throw new \RuntimeException('Choose between 1 and 365 days');
        }
        [$i, $d, $b] = $this->itemForActor($actor, $id);
        if (!in_array($i['source_type'], ['quick', 'task'], true)) {
            throw new \RuntimeException('Only tasks and your own items can be postponed');
        }
        $today = LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']);
        if ($d['day'] !== $today) {
            throw new \RuntimeException('Only items of today can be postponed');
        }
        $due = (new \DateTimeImmutable($today))->modify("+$days days")->format('Y-m-d');
        $shift = null;
        if ($i['source_type'] === 'task') {
            if ($i['completed']) {
                throw new \RuntimeException('A finished task stays where it was done. Untick it first');
            }
            if ($i['parent_id'] !== null) {
                throw new \RuntimeException('A subtask moves with its parent task');
            }
            // The write to Tasks comes first: if it fails nothing else has changed.
            $shift = ['source_id' => (string) $i['source_id'], 'days' => $this->dav->shiftTask((string) $i['source_id'], $due)];
        }
        $this->purgeTrash();
        $block = $this->takeBlock($i);
        $block['title'] = (string) $i['title'];
        if ($shift !== null) {
            $block['shift'] = $shift;
        }
        $trash = $this->trash((int) $b['id'], (string) $d['day'], $due, $block);
        $this->activity->itemPostponed($actor, (string) $b['owner_uid'], (string) $i['title'], $due);
        $this->events?->emit('todo.item.postponed', (string) $b['owner_uid'], $actor, [
            'item_id' => $id, 'day' => (string) $d['day'], 'title' => (string) $i['title'], 'kind' => (string) $i['source_type'], 'due' => $due, 'trash_id' => $trash,
        ]);

        return ['trash' => $trash, 'due' => $due];
    }

    /**
     * Undo a delete or a postpone. Normally the items go back exactly where they were (the Undo
     * bar). With `$today` (the Postponed page), or when their day can no longer be edited, they
     * are brought to today instead: quick items go in the Day items slot, and a postponed task's
     * dates are moved so it is placed on today.
     */
    public function restore(string $actor, int $trashId, bool $today = false): void
    {
        $this->db->beginTransaction();
        try {
            $this->restoreCopy($actor, $trashId, $today);
            $this->db->commit();
        } catch (\Throwable $error) {
            $this->db->rollBack();
            throw $error;
        }
    }

    private function restoreCopy(string $actor, int $trashId, bool $today): void
    {
        $t = $this->one('daily_todo_trash', ['id' => $trashId]) ?? throw new \RuntimeException('There is nothing to restore any more');
        $b = $this->one('daily_todo_boards', ['id' => $t['board_id']]) ?? throw new \RuntimeException('There is nothing to restore any more');
        $b = $this->accessibleBoard($actor, $b['owner_uid']);
        $logical = LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']);
        $original = $this->one('daily_todo_days', ['board_id' => $b['id'], 'day' => $t['day']]);
        $inPlace = !$today && $original !== null && LogicalDate::editable((string) $t['day'], $logical);
        // Claim the copy first, so two restores (or a restore racing the day it waits for) cannot both use it.
        $q = $this->db->getQueryBuilder();
        if ($q->delete('daily_todo_trash')->where($q->expr()->eq('id', $q->createNamedParameter($trashId, IQueryBuilder::PARAM_INT)))->executeStatement() !== 1) {
            throw new \RuntimeException('There is nothing to restore any more');
        }
        $block = json_decode((string) $t['payload'], true) ?: [];
        if (!empty($block['deleted_tasks'])) {
            $this->dav->restoreTasks($block['deleted_tasks']);
            if (!$inPlace) {
                // A restored subtask still follows its parent; a root moves to today.
                $root = $block['deleted_tasks'][0];
                $component = \Sabre\VObject\Reader::read($root['calendardata'])->VTODO;
                if (!isset($component->{'RELATED-TO'}) && !isset($component->RRULE) && !isset($component->RDATE)
                    && (isset($component->DTSTART) || isset($component->DUE))) {
                    $this->dav->shiftTask($block['root_task'], $logical);
                }
            }
        }
        if (!empty($block['shift'])) {
            try {
                if ($inPlace) {
                    $this->dav->shiftTaskBy($block['shift']['source_id'], -(int) $block['shift']['days']);
                } else {
                    $this->dav->shiftTask($block['shift']['source_id'], $logical);
                }
            } catch (\Throwable $error) {
                $this->trash((int) $t['board_id'], (string) $t['day'], $t['due_day'], $block); // keep it: nothing was restored
                throw $error;
            }
        }
        if ($inPlace) {
            $this->putBack($original, $block);
        } elseif (!empty($block['deleted_tasks'])) {
            $destination = $this->dayRow($b, $logical);
            $this->reconcile($b, $destination, $logical);
            // Retain quick children and nesting, using the Day items slot rather than old positions.
            $position = $this->quickInsertPosition($b, $destination);
            $ordered = array_merge($block['tasks'] ?? [], $block['rows'] ?? []);
            usort($ordered, fn($a, $c) => $a['position'] <=> $c['position']);
            $positions = [];
            foreach ($ordered as $n => $row) $positions[$row['id']] = $position + $n;
            foreach (['tasks', 'rows'] as $field) {
                foreach ($block[$field] ?? [] as $n => $row) $block[$field][$n]['position'] = $positions[$row['id']];
            }
            $this->putBack($destination, $block);
        } else {
            $this->placeQuickRows($b, $this->dayRow($b, $logical), $block['rows'] ?? []);
        }
        $this->activity->itemRestored($actor, (string) $b['owner_uid'], (string) ($block['title'] ?? ''));
        $this->events?->emit('todo.item.restored', (string) $b['owner_uid'], $actor, [
            'trash_id' => $trashId, 'day' => $inPlace ? (string) $t['day'] : $logical, 'title' => (string) ($block['title'] ?? ''),
        ]);
    }

    /**
     * What the Postponed page lists: items waiting for their day, and recently deleted ones.
     *
     * @return list<array{id: int, kind: string, title: string, count: int, day: string, due: ?string, created_at: int}>
     */
    public function trashList(string $actor): array
    {
        $b = $this->accessibleBoard($actor);
        $this->purgeTrash();
        $out = [];
        foreach (array_reverse($this->rows('daily_todo_trash', ['board_id' => $b['id']])) as $t) {
            $block = json_decode((string) $t['payload'], true) ?: [];
            $out[] = [
                'id' => (int) $t['id'],
                'kind' => $t['due_day'] === null ? 'deleted' : 'postponed',
                'title' => (string) ($block['title'] ?? ($block['rows'][0]['title'] ?? '')),
                'count' => count($block['rows'] ?? []) + count($block['tasks'] ?? []),
                'day' => (string) $t['day'],
                'due' => $t['due_day'],
                'created_at' => (int) $t['created_at'],
            ];
        }

        return $out;
    }

    /**
     * Take an item and everything below it off its day and describe it for `trash()`. Quick items
     * (and, below a task, its subtasks) are deleted and kept; items that are not part of a copy
     * (tasks under a quick item) stay and become top-level.
     *
     * @return array{rows: list<array<string, mixed>>, tasks: list<array<string, mixed>>, detached: list<array{id: int, parent: int}>}
     */
    private function takeBlock(array $item): array
    {
        $rows = [];
        $tasks = [];
        $detached = [];
        foreach (array_merge([$item], $this->descendants((int) $item['day_id'], (int) $item['id'])) as $row) {
            $q = $this->db->getQueryBuilder();
            $snapshot = [
                'id' => (int) $row['id'],
                'parent' => $row['parent_id'] === null ? null : (int) $row['parent_id'],
                'source_id' => $row['source_id'],
                'title' => (string) $row['title'],
                'position' => (int) $row['position'],
                'completed' => (bool) $row['completed'],
                'starts_at' => $row['starts_at'],
                'due_at' => $row['due_at'],
                'all_day' => (bool) $row['all_day'],
                'href' => $row['href'],
            ];
            if ($row['source_type'] === 'quick') {
                $rows[] = $snapshot;
            } elseif ($row['source_type'] === 'task' && $item['source_type'] === 'task') {
                $tasks[] = $snapshot;
            } else {
                $detached[] = ['id' => (int) $row['id'], 'parent' => (int) $row['parent_id']];
                $q->update('daily_todo_items')->set('parent_id', $q->createNamedParameter(null, IQueryBuilder::PARAM_INT))->where($q->expr()->eq('id', $q->createNamedParameter((int) $row['id'])))->executeStatement();
                continue;
            }
            $q->delete('daily_todo_items')->where($q->expr()->eq('id', $q->createNamedParameter((int) $row['id'])))->executeStatement();
        }

        return ['rows' => $rows, 'tasks' => $tasks, 'detached' => $detached];
    }

    /** Insert a copy made by `takeBlock` back into its own day, in its old place and nesting. */
    private function putBack(array $day, array $block): void
    {
        $all = array_merge(array_map(fn($row) => $row + ['is_task' => true], $block['tasks'] ?? []), $block['rows'] ?? []);
        usort($all, fn($a, $c) => $a['position'] <=> $c['position']);
        $known = array_column($this->rows('daily_todo_items', ['day_id' => $day['id']]), null, 'id');
        $byKey = [];
        foreach ($known as $row) {
            $byKey[$row['source_type'] . ':' . $row['source_id']] = (int) $row['id'];
        }
        $base = $all ? (int) $all[0]['position'] : 0;
        $this->shiftPositions((int) $day['id'], $base, count($all));
        $map = [];
        foreach ($all as $n => $row) {
            $isTask = !empty($row['is_task']);
            $key = 'task:' . $row['source_id'];
            if ($isTask && isset($byKey[$key])) {
                $map[$row['id']] = $byKey[$key]; // a refresh already brought it back
                continue;
            }
            $parent = $row['parent'] === null ? null : ($map[$row['parent']] ?? (isset($known[$row['parent']]) ? (int) $row['parent'] : null));
            $map[$row['id']] = $this->insertItem($day['id'], [
                'source_type' => $isTask ? 'task' : 'quick',
                'source_id' => $isTask ? $row['source_id'] : bin2hex(random_bytes(12)),
                'title' => $row['title'],
                'starts_at' => $isTask ? $row['starts_at'] : null,
                'due_at' => $isTask ? $row['due_at'] : null,
                'all_day' => $isTask ? $row['all_day'] : false,
                'completed' => $row['completed'],
                'href' => $isTask ? $row['href'] : null,
            ], $base + $n, $parent);
        }
        foreach ($block['detached'] ?? [] as $child) {
            if (isset($map[$child['parent']]) && isset($known[$child['id']])) {
                $q = $this->db->getQueryBuilder();
                $q->update('daily_todo_items')->set('parent_id', $q->createNamedParameter($map[$child['parent']], IQueryBuilder::PARAM_INT))->where($q->expr()->eq('id', $q->createNamedParameter((int) $child['id'], IQueryBuilder::PARAM_INT)))->executeStatement();
            }
        }
    }

    private function trash(int $boardId, string $day, ?string $dueDay, array $block): int
    {
        $q = $this->db->getQueryBuilder();
        $q->insert('daily_todo_trash')->values([
            'board_id' => $q->createNamedParameter($boardId, IQueryBuilder::PARAM_INT),
            'day' => $q->createNamedParameter($day),
            'due_day' => $q->createNamedParameter($dueDay),
            'payload' => $q->createNamedParameter(json_encode($block, JSON_THROW_ON_ERROR)),
            'created_at' => $q->createNamedParameter(time(), IQueryBuilder::PARAM_INT),
        ])->executeStatement();

        return (int) $this->db->lastInsertId('daily_todo_trash');
    }

    /** Deleted items are kept for a week; items waiting for their day are kept until it comes. */
    private function purgeTrash(): void
    {
        $q = $this->db->getQueryBuilder();
        $q->delete('daily_todo_trash')->where($q->expr()->isNull('due_day'))->andWhere($q->expr()->lt('created_at', $q->createNamedParameter(time() - 7 * 86400, IQueryBuilder::PARAM_INT)))->executeStatement();
    }

    /** Place the items that were postponed to this day (or an earlier one nobody opened). Postponed tasks need nothing: their new date places them. */
    private function placePostponed(array $b, array $d, string $day): void
    {
        $q = $this->db->getQueryBuilder();
        $q->select('*')->from('daily_todo_trash')
            ->where($q->expr()->eq('board_id', $q->createNamedParameter((int) $b['id'], IQueryBuilder::PARAM_INT)))
            ->andWhere($q->expr()->isNotNull('due_day'))
            ->andWhere($q->expr()->lte('due_day', $q->createNamedParameter($day)))
            ->orderBy('id');
        foreach ($q->executeQuery()->fetchAllAssociative() as $t) {
            $q = $this->db->getQueryBuilder();
            if ($q->delete('daily_todo_trash')->where($q->expr()->eq('id', $q->createNamedParameter((int) $t['id'], IQueryBuilder::PARAM_INT)))->executeStatement() !== 1) {
                continue; // placed (or undone) meanwhile
            }
            $this->placeQuickRows($b, $d, json_decode((string) $t['payload'], true)['rows'] ?? []);
        }
    }

    /** Add quick items (in their old order and nesting) to the day's Day items slot, as fresh unticked items. */
    private function placeQuickRows(array $b, array $d, array $rows): void
    {
        if (!$rows) {
            return;
        }
        usort($rows, fn($a, $c) => $a['position'] <=> $c['position']);
        $position = $this->quickInsertPosition($b, $d);
        $this->shiftPositions((int) $d['id'], $position, count($rows));
        $map = [];
        foreach ($rows as $n => $row) {
            // A subtask whose parent stayed behind becomes top-level.
            $map[$row['id']] = $this->insertItem($d['id'], [
                'source_type' => 'quick',
                'source_id' => bin2hex(random_bytes(12)),
                'title' => $row['title'],
            ], $position + $n, $row['parent'] === null ? null : ($map[$row['parent']] ?? null));
        }
    }
    /** The task behind a day item, as stored in Tasks, for the task editor. */
    public function taskDetails(string $actor, int $id): array
    {
        [$i] = $this->itemForActor($actor, $id);
        if ($i['source_type'] !== 'task') {
            throw new \RuntimeException('Only tasks have details');
        }

        return $this->dav->taskDetails((string) $i['source_id']);
    }

    /**
     * Save the task editor: title, notes, priority, start and due day, written to Tasks. When the
     * edit moves the task to another day it leaves this day (its own quick subtasks wait in the
     * Postponed page), and it is placed on its new day by that date like any task.
     *
     * @param array{title: string, description: string, start: ?string, due: ?string, priority: int} $edit
     */
    public function editTask(string $actor, int $id, array $edit): array
    {
        [$i, $d, $b] = $this->itemForActor($actor, $id);
        if ($i['source_type'] !== 'task') {
            throw new \RuntimeException('Only tasks can be edited here');
        }
        $before = $this->dav->taskDetails((string) $i['source_id']);
        $this->dav->editTask((string) $i['source_id'], $edit);
        $after = $this->dav->taskDetails((string) $i['source_id']);
        $q = $this->db->getQueryBuilder();
        $q->update('daily_todo_items')->set('title', $q->createNamedParameter($after['title']))->where($q->expr()->eq('id', $q->createNamedParameter($id, IQueryBuilder::PARAM_INT)))->executeStatement();

        $was = $before['start'] ?? $before['due'];
        $now = $after['start'] ?? $after['due'];
        $moved = $was !== $now && $now !== $d['day'] && $i['parent_id'] === null;
        if ($moved) {
            $block = $this->takeBlock($i);
            $block['title'] = $after['title'];
            if ($block['rows']) {
                $this->trash((int) $b['id'], (string) $d['day'], $now !== null && $now > $d['day'] ? $now : null, $block);
            }
        }

        return ['title' => $after['title'], 'moved' => $moved, 'day' => $now];
    }

    /**
     * Unfinished tasks whose day has passed and that are not on today's list, for the "overdue"
     * nudge (your own list).
     *
     * @return list<array{id: string, title: string, date: string}>
     */
    public function overdue(string $actor): array
    {
        $b = $this->accessibleBoard($actor);
        $today = LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']);
        $overdue = $this->dav->overdueTasks((string) $b['owner_uid'], $today, json_decode($b['task_lists'], true) ?: []);
        $day = $this->one('daily_todo_days', ['board_id' => $b['id'], 'day' => $today]);
        $onToday = [];
        foreach ($day ? $this->rows('daily_todo_items', ['day_id' => $day['id']]) : [] as $row) {
            if ($row['source_type'] === 'task') {
                $onToday[$row['source_id']] = true;
            }
        }

        return array_values(array_filter($overdue, fn($task) => !isset($onToday[$task['id']])));
    }

    /** Move an overdue task to today (its dates in Tasks move; today's list shows it on the next read). */
    public function moveOverdueToToday(string $actor, string $sourceId): void
    {
        $b = $this->accessibleBoard($actor);
        $today = LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']);
        $calendar = explode(':', $sourceId, 2)[0];
        if (!in_array($calendar, array_map('strval', json_decode($b['task_lists'], true) ?: []), true)) {
            throw new \RuntimeException('That task is not in a list you show here');
        }
        $this->dav->shiftTask($sourceId, $today);
    }
    public function template(string $actor): array
    {
        $b = $this->accessibleBoard($actor);
        $this->ensureDefaultTemplate($b);
        return array_map(fn($r) => ['id' => (int) $r['id'],'title' => $r['title']], $this->rows('daily_todo_templates', ['board_id' => $b['id']], 'position'));
    }

    public function resetDay(string $actor, string $day): void
    {
        $board = $this->accessibleBoard($actor);
        if ($board['owner_uid'] !== $actor) {
            throw new \RuntimeException('Only the owner may regenerate a day');
        }

        $logicalToday = LogicalDate::forTimestamp(
            time(),
            $board['timezone'],
            (int) $board['rollover_hour'],
        );
        if ($day !== $logicalToday) {
            throw new \RuntimeException('Only the current logical day can be regenerated');
        }

        $this->ensureDefaultTemplate($board);
        $dayRow = $this->dayRow($board, $day);
        $this->db->beginTransaction();
        try {
            $query = $this->db->getQueryBuilder();
            $query->delete('daily_todo_items')
                ->where($query->expr()->eq('day_id', $query->createNamedParameter($dayRow['id'])))
                ->executeStatement();
            $this->reconcile($board, $dayRow, $day, $board['rollover_mode'] === 'all');
            $yesterday = (new \DateTimeImmutable($day))->modify('-1 day')->format('Y-m-d');
            $previous = $this->one('daily_todo_days', ['board_id' => $board['id'], 'day' => $yesterday]);
            if ($previous && $board['rollover_mode'] !== 'none') {
                // Tasks were read fresh above: do not revive stale historical task rows.
                $this->carryForward(array_replace($board, ['rollover_mode' => 'quick_only']), $dayRow, $previous);
            }
            $this->db->commit();
        } catch (\Throwable $error) {
            $this->db->rollBack();
            throw $error;
        }
    }

    private function ensureDefaultTemplate(array $board): void
    {
        if ($this->rows('daily_todo_templates', ['board_id' => $board['id']])) {
            return;
        }

        foreach (self::DEFAULT_TEMPLATE as $position => $title) {
            $query = $this->db->getQueryBuilder();
            $query->insert('daily_todo_templates')->values([
                'board_id' => $query->createNamedParameter($board['id']),
                'title' => $query->createNamedParameter($title),
                'position' => $query->createNamedParameter($position, IQueryBuilder::PARAM_INT),
            ])->executeStatement();
        }
    }
    public function saveTemplate(string $actor, array $rows): array
    {
        $b = $this->accessibleBoard($actor);
        if ($b['owner_uid'] !== $actor) {
            throw new \RuntimeException('Only the owner may change routines');
        }if (count(array_filter($rows, fn($r) => ($r['title'] ?? '') === '__DAY_ITEMS__')) !== 1) {
            throw new \RuntimeException('The template requires exactly one Day items placeholder');
        }
        // Update rows in place so routine items already on today's list keep their ids.
        $existing = array_map(fn($r) => (int) $r['id'], $this->rows('daily_todo_templates', ['board_id' => $b['id']]));
        $keep = [];
        $position = 0;
        foreach ($rows as $r) {
            $title = trim((string) ($r['title'] ?? ''));
            if ($title === '') {
                continue;
            }
            $id = (int) ($r['id'] ?? 0);
            $q = $this->db->getQueryBuilder();
            if ($id > 0 && in_array($id, $existing, true) && !isset($keep[$id])) {
                $keep[$id] = true;
                $q->update('daily_todo_templates')->set('title', $q->createNamedParameter($title))->set('position', $q->createNamedParameter($position, IQueryBuilder::PARAM_INT))->where($q->expr()->eq('id', $q->createNamedParameter($id)))->andWhere($q->expr()->eq('board_id', $q->createNamedParameter($b['id'])))->executeStatement();
            } else {
                $q->insert('daily_todo_templates')->values(['board_id' => $q->createNamedParameter($b['id']),'title' => $q->createNamedParameter($title),'position' => $q->createNamedParameter($position, IQueryBuilder::PARAM_INT)])->executeStatement();
            }
            $position++;
        }
        foreach (array_diff($existing, array_keys($keep)) as $id) {
            $q = $this->db->getQueryBuilder();
            $q->delete('daily_todo_templates')->where($q->expr()->eq('id', $q->createNamedParameter($id)))->andWhere($q->expr()->eq('board_id', $q->createNamedParameter($b['id'])))->executeStatement();
        }
        return $this->template($actor);
    }
    /**
     * Who the board is shared with (owner only). A share lets that person or group see
     * and edit the day list; the template, settings and sharing stay with the owner.
     *
     * @return list<array{id: int, share_type: string, share_with: string, display_name: string}>
     */
    public function shares(string $actor): array
    {
        $b = $this->accessibleBoard($actor);
        if ($b['owner_uid'] !== $actor) {
            throw new \RuntimeException('Only the owner may manage sharing');
        }
        return array_map(fn(array $row) => [
            'id' => (int) $row['id'],
            'share_type' => $row['share_type'],
            'share_with' => $row['share_with'],
            'display_name' => $row['share_type'] === 'user' ? ($this->users->getDisplayName($row['share_with']) ?: $row['share_with']) : $row['share_with'],
        ], $this->rows('daily_todo_shares', ['board_id' => $b['id']], 'id'));
    }

    public function addShare(string $actor, string $type, string $with): void
    {
        $b = $this->accessibleBoard($actor);
        $with = trim($with);
        if ($b['owner_uid'] !== $actor) {
            throw new \RuntimeException('Only the owner may manage sharing');
        }
        if (!in_array($type, ['user', 'group'], true) || $with === '') {
            throw new \RuntimeException('Invalid share');
        }
        if ($type === 'user' && $with === $actor) {
            throw new \RuntimeException('This is already your list');
        }
        if ($type === 'user' && !$this->users->userExists($with)) {
            throw new \RuntimeException("There is no user called \"$with\"");
        }
        if ($type === 'group' && !$this->groups->groupExists($with)) {
            throw new \RuntimeException("There is no group called \"$with\"");
        }
        foreach ($this->rows('daily_todo_shares', ['board_id' => $b['id']]) as $existing) {
            if ($existing['share_type'] === $type && $existing['share_with'] === $with) {
                throw new \RuntimeException('Already shared with ' . $with);
            }
        }
        $q = $this->db->getQueryBuilder();
        $q->insert('daily_todo_shares')->values(['board_id' => $q->createNamedParameter($b['id']),'share_type' => $q->createNamedParameter($type),'share_with' => $q->createNamedParameter($with)])->executeStatement();
        $recipients = [$with];
        if ($type === 'group') {
            $recipients = array_map(fn($user) => $user->getUID(), array_slice($this->groups->get($with)?->getUsers() ?? [], 0, 200));
        }
        $this->activity->listShared($actor, array_values(array_diff($recipients, [$actor])));
    }

    /**
     * The boards other people shared with this user (directly or through a group).
     *
     * @return list<array{owner: string, name: string}>
     */
    public function sharedWithMe(string $actor): array
    {
        $user = $this->users->get($actor);
        $groups = $user ? $this->groups->getUserGroupIds($user) : [];
        $q = $this->db->getQueryBuilder();
        $q->select('s.share_type', 's.share_with', 'b.owner_uid')
            ->from('daily_todo_shares', 's')
            ->innerJoin('s', 'daily_todo_boards', 'b', $q->expr()->eq('b.id', 's.board_id'))
            ->where($q->expr()->neq('b.owner_uid', $q->createNamedParameter($actor)));
        $out = [];
        foreach ($q->executeQuery()->fetchAllAssociative() as $row) {
            $matches = ($row['share_type'] === 'user' && $row['share_with'] === $actor)
                || ($row['share_type'] === 'group' && in_array($row['share_with'], $groups, true));
            if ($matches) {
                $out[$row['owner_uid']] = ['owner' => $row['owner_uid'], 'name' => $this->users->getDisplayName($row['owner_uid']) ?: $row['owner_uid']];
            }
        }
        $out = array_values($out);
        usort($out, fn($a, $b) => strcasecmp($a['name'], $b['name']));

        return $out;
    }
    public function deleteShare(string $actor, int $id): void
    {
        $b = $this->accessibleBoard($actor);
        if ($b['owner_uid'] !== $actor) {
            throw new \RuntimeException('Only the owner may manage sharing');
        }$q = $this->db->getQueryBuilder();
        $q->delete('daily_todo_shares')->where($q->expr()->eq('id', $q->createNamedParameter($id)))->andWhere($q->expr()->eq('board_id', $q->createNamedParameter($b['id'])))->executeStatement();
    }
    public function materializeAll(): void
    {
        $this->purgeTrash();
        $q = $this->db->getQueryBuilder();
        $q->select('*')->from('daily_todo_boards');
        foreach ($q->executeQuery()->fetchAllAssociative() as $b) {
            $this->materializeBoard($b);
        }
    }

    private function materializeBoard(array $b): void
    {
        $today = LogicalDate::forTimestamp(time(), $b['timezone'], (int) $b['rollover_hour']);
        $d = $this->dayRow($b, $today);
        $this->reconcile($b, $d, $today);
        $y = (new \DateTimeImmutable($today))->modify('-1 day')->format('Y-m-d');
        $previous = $this->one('daily_todo_days', ['board_id' => $b['id'],'day' => $y]);
        // Freezing yesterday below marks its rollover as consumed. Repeating it would
        // resurrect items deleted or postponed after they were carried into today.
        if ($previous && !$previous['frozen'] && $b['rollover_mode'] !== 'none') {
            $this->carryForward($b, $d, $previous);
        }
        $q = $this->db->getQueryBuilder();
        $q->update('daily_todo_days')->set('frozen', $q->createNamedParameter(true, IQueryBuilder::PARAM_BOOL))
            ->where($q->expr()->eq('board_id', $q->createNamedParameter($b['id'])))
            ->andWhere($q->expr()->lt('day', $q->createNamedParameter($today)))->executeStatement();
    }

    private function carryForward(array $b, array $d, array $previous): void
    {
        $excluded = [];
        foreach ($this->rows('daily_todo_trash', ['board_id' => $b['id']]) as $trash) {
            $block = json_decode((string) $trash['payload'], true) ?: [];
            if ($trash['day'] !== $d['day'] && empty($block['deleted_tasks'])) continue;
            foreach ($block['deleted_tasks'] ?? [] as $copy) $excluded['task:' . $copy['calendarid'] . ':' . $copy['uri']] = true;
            foreach (['rows' => 'quick', 'tasks' => 'task'] as $field => $type) {
                foreach ($block[$field] ?? [] as $row) {
                    $excluded[$type . ':' . $row['source_id']] = true;
                }
            }
        }
        $keys = [];
        foreach ($this->rows('daily_todo_items', ['day_id' => $d['id']]) as $item) {
            $keys[EntryTree::key($item)] = (int) $item['id'];
        }
        $carried = [];
        foreach ($this->rows('daily_todo_items', ['day_id' => $previous['id']], 'position') as $item) {
            $key = EntryTree::key($item);
            if (isset($keys[$key])) {
                $carried[(int) $item['id']] = $keys[$key];
                continue;
            }
            $carry = !$item['completed'] && !isset($excluded[$key]) && EntryTree::separator((string) $item['title']) === null
                && ($item['source_type'] === 'quick' || ($b['rollover_mode'] === 'all' && $item['source_type'] === 'task'));
            if ($carry) {
                $item['completed'] = false;
                $item['error'] = null;
                $parent = $item['parent_id'] === null ? null : ($carried[(int) $item['parent_id']] ?? null);
                $pos = $this->quickInsertPosition($b, $d);
                $this->shiftPositions((int) $d['id'], $pos);
                $carried[(int) $item['id']] = $this->insertItem($d['id'], $item, $pos, $parent);
                $keys[$key] = $carried[(int) $item['id']];
            }
        }
    }
}

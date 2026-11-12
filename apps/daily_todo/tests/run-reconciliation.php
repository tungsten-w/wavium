<?php

declare(strict_types=1);

// Exercise the real BoardService reconciliation with in-memory database and DAV ports.
namespace OCP {
    interface IDBConnection {}
    interface IGroupManager {}
    interface IUserManager {}
}
namespace OCP\DB\QueryBuilder {
    interface IQueryBuilder { public const PARAM_INT = 1; }
}
namespace OCA\DailyTodo\Service {
    final class ActivityPublisher {}
    final class CalDavAdapter {
        public function entries(string $uid, string $day, array $tasks, array $calendars): array { return []; }
        public function eventMovedOffDay(string $sourceId, string $day): bool { return in_array($sourceId, ['1:moved.ics', '1:moved-completed.ics'], true); }
    }
}
namespace {
    require_once __DIR__ . '/../lib/Service/EntryTree.php';
    require_once __DIR__ . '/../lib/Service/BoardService.php';

    final class MemoryDb implements \OCP\IDBConnection {
        public array $items;
        public function getQueryBuilder(): MemoryQuery { return new MemoryQuery($this); }
    }
    final class MemoryQuery {
        private string $table = '';
        private string $operation = 'select';
        private array $conditions = [];
        private array $changes = [];
        public function __construct(private MemoryDb $db) {}
        public function select(...$columns): self { return $this; }
        public function from(string $table): self { $this->table = $table; return $this; }
        public function update(string $table): self { $this->table = $table; $this->operation = 'update'; return $this; }
        public function delete(string $table): self { $this->table = $table; $this->operation = 'delete'; return $this; }
        public function createNamedParameter($value, $type = null) { return $value; }
        public function expr(): self { return $this; }
        public function eq(string $key, $value): array { return [$key, $value]; }
        public function isNotNull(string $key): array { return [$key, null]; }
        public function lte(string $key, $value): array { return [$key, $value]; }
        public function where(array $condition): self { $this->conditions = [$condition]; return $this; }
        public function andWhere(array $condition): self { $this->conditions[] = $condition; return $this; }
        public function orderBy(string $key, string $direction = 'ASC'): self { return $this; }
        public function set(string $key, $value): self { $this->changes[$key] = $value; return $this; }
        private function matches(array $row): bool {
            foreach ($this->conditions as [$key, $value]) { if ($row[$key] !== $value) { return false; } }
            return true;
        }
        public function executeQuery(): self { return $this; }
        public function fetchAllAssociative(): array {
            return $this->table === 'daily_todo_items' ? array_values(array_filter($this->db->items, fn($row) => $this->matches($row))) : [];
        }
        public function executeStatement(): int {
            $count = 0;
            foreach ($this->db->items as $id => $row) {
                if (!$this->matches($row)) { continue; }
                if ($this->operation === 'delete') { unset($this->db->items[$id]); }
                else { $this->db->items[$id] = array_replace($row, $this->changes); }
                $count++;
            }
            return $count;
        }
    }
    $db = new MemoryDb();
    $item = static fn(int $id, string $type, string $source, bool $done = false, ?int $parent = null): array => [
        'id' => $id, 'day_id' => 10, 'source_type' => $type, 'source_id' => $source,
        'completed' => $done, 'parent_id' => $parent, 'position' => $id, 'title' => 'item ' . $id,
    ];
    $db->items = [
        1 => $item(1, 'event', '1:moved.ics'),
        2 => $item(2, 'event', '1:moved-completed.ics', true),
        3 => $item(3, 'event', '1:unavailable.ics'),
        4 => $item(4, 'task', '1:moved.ics'),
        5 => $item(5, 'quick', '', false, 1),
        6 => $item(6, 'quick', ''),
    ];
    $service = new \OCA\DailyTodo\Service\BoardService($db,
        new class implements \OCP\IGroupManager {}, new \OCA\DailyTodo\Service\CalDavAdapter(),
        new class implements \OCP\IUserManager {}, new \OCA\DailyTodo\Service\ActivityPublisher());
    $reconcile = new \ReflectionMethod($service, 'reconcile');
    $board = ['id' => 20, 'owner_uid' => 'alice', 'task_lists' => '[]', 'calendars' => '["1"]'];
    $day = ['id' => 10];
    $reconcile->invoke($service, $board, $day, '2026-10-03');
    $expected = $db->items;
    $reconcile->invoke($service, $board, $day, '2026-10-03');
    $cases = [
        'moved incomplete event is removed' => !isset($db->items[1]),
        'completed event history survives' => isset($db->items[2]),
        'unverified source survives' => isset($db->items[3]),
        'carried task survives' => isset($db->items[4]),
        'quick child survives and is detached' => isset($db->items[5]) && $db->items[5]['parent_id'] === null,
        'other quick item preserves order' => isset($db->items[6]) && $db->items[6]['position'] === 6,
        'repeated read is idempotent' => $db->items === $expected,
    ];
    $failures = 0;
    foreach ($cases as $name => $passed) {
        echo ($passed ? 'PASS ' : 'FAIL ') . $name . "\n";
        if (!$passed) { $failures++; }
    }
    exit($failures ? 1 : 0);
}

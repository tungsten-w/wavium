<?php

declare(strict_types=1);

require_once __DIR__ . '/../lib/Service/LogicalDate.php';
require_once __DIR__ . '/../lib/Service/EntryTree.php';
require_once __DIR__ . '/../lib/Service/CalDavAdapter.php';
require_once __DIR__ . '/../lib/Service/BoardService.php';

use OCA\DailyTodo\Service\EntryTree;
use OCA\DailyTodo\Service\LogicalDate;
use OCA\DailyTodo\Service\CalDavAdapter;
use OCA\DailyTodo\Service\BoardService;

$cases = [
    'before rollover' => ['2026-09-30 02:59:59', 'Europe/Paris', 3, '2026-09-29'],
    'at rollover' => ['2026-09-30 03:00:00', 'Europe/Paris', 3, '2026-09-30'],
    'DST spring before rollover' => ['2026-03-29 01:30:00', 'Europe/Paris', 3, '2026-03-28'],
    'DST spring after rollover' => ['2026-03-29 03:30:00', 'Europe/Paris', 3, '2026-03-29'],
    'DST autumn before rollover' => ['2026-10-25 02:30:00', 'Europe/Paris', 3, '2026-10-24'],
];

$failures = 0;
foreach ($cases as $name => [$localTime, $timezone, $hour, $expected]) {
    $timestamp = (new DateTimeImmutable($localTime, new DateTimeZone($timezone)))->getTimestamp();
    $actual = LogicalDate::forTimestamp($timestamp, $timezone, $hour);
    if ($actual !== $expected) {
        fwrite(STDERR, "FAIL {$name}: expected {$expected}, got {$actual}\n");
        $failures++;
    } else {
        echo "PASS {$name}\n";
    }
}

$editCases = [
    ['2026-09-30', true],
    ['2026-09-29', true],
    ['2026-09-28', true],
    ['2026-09-27', false],
    ['2026-10-01', false], // a day that has not started does not exist
    ['2026-10-02', false],
];
foreach ($editCases as [$day, $expected]) {
    $actual = LogicalDate::editable($day, '2026-09-30');
    if ($actual !== $expected) {
        fwrite(STDERR, "FAIL editable {$day}\n");
        $failures++;
    } else {
        echo "PASS editable {$day}\n";
    }
}

$entry = static fn(string $id, ?string $parent = null, bool $allDay = false, ?int $start = null): array => [
    'source_type' => 'task', 'source_id' => $id, 'title' => $id, 'starts_at' => $start,
    'all_day' => $allDay, 'parent_key' => $parent === null ? null : 'task:' . $parent,
];
$order = static fn(array $entries): string => implode(',', array_map(
    static fn(array $e) => $e['source_id'] . ($e['parent_key'] === null ? '' : '<' . substr($e['parent_key'], 5)),
    EntryTree::order($entries),
));
$treeCases = [
    'children follow their parent, roots sorted by time' => [
        [$entry('late', null, false, 200), $entry('c1', 'early'), $entry('early', null, false, 100), $entry('c2', 'early'), $entry('allday', null, true), $entry('none')],
        'allday,early,c1<early,c2<early,late,none',
    ],
    'orphan child becomes a root' => [
        [$entry('a', 'missing'), $entry('b')],
        'a,b',
    ],
    'cycle does not loop, duplicate or drop items' => [
        [$entry('x', 'y'), $entry('y', 'x')],
        'x<y,y<x',
    ],
];
foreach ($treeCases as $name => [$entries, $expected]) {
    $actual = $order($entries);
    if ($actual !== $expected) {
        fwrite(STDERR, "FAIL tree {$name}: expected {$expected}, got {$actual}\n");
        $failures++;
    } else {
        echo "PASS tree {$name}\n";
    }
}

$splitCases = [
    ['↳ 💾 anki', ['💾 anki', true]],
    ['↳anki', ['anki', true]],
    ['  walk ', ['walk', false]],
    ['a ↳ b', ['a ↳ b', false]],
];
foreach ($splitCases as [$title, $expected]) {
    if (EntryTree::splitSubItem($title) !== $expected) {
        fwrite(STDERR, "FAIL splitSubItem {$title}\n");
        $failures++;
    } else {
        echo "PASS splitSubItem {$title}\n";
    }
}

$separatorCases = [['---', 'rule'], [' ___ ', 'rule'], ['<br>', 'space'], ['<BR />', 'space'], ['--- x', null], ['br', null], ['study', null]];
foreach ($separatorCases as [$title, $expected]) {
    if (EntryTree::separator($title) !== $expected) {
        fwrite(STDERR, "FAIL separator {$title}\n");
        $failures++;
    } else {
        echo "PASS separator {$title}\n";
    }
}

$moveCases = [
    'move to tomorrow' => ['2026-10-04', '2026-10-05', '2026-10-03', true],
    'move to yesterday' => ['2026-10-02', '2026-10-03', '2026-10-03', true],
    'unchanged event' => ['2026-10-03', '2026-10-04', '2026-10-03', false],
    'multiday event still overlaps' => ['2026-10-02', '2026-10-05', '2026-10-03', false],
    'exclusive end is no overlap' => ['2026-10-02', '2026-10-03', '2026-10-03', true],
    'missing start preserves item' => [null, null, '2026-10-03', false],
    'event without end moved' => ['2026-10-04', null, '2026-10-03', true],
];
foreach ($moveCases as $name => [$start, $end, $day, $expected]) {
    if (CalDavAdapter::eventDateMovedOffDay($start, $end, $day) !== $expected) {
        fwrite(STDERR, "FAIL {$name}\n");
        $failures++;
    } else {
        echo "PASS {$name}\n";
    }
}

$titleCases = [
    'trim and subitem arrow' => [['  📚 study ', '↳ 💾 anki', '↳💾 anki'], ['📚 study', '💾 anki']],
    'blank lines dropped' => [['', '   ', "\t", 'a'], ['a']],
    'other emoji kept intact' => [['⏯️ video', '↳ ⏯️ video'], ['⏯️ video']],
    'arrow only inside is kept' => [['a ↳ b'], ['a ↳ b']],
];
foreach ($titleCases as $name => [$in, $expected]) {
    $actual = BoardService::normalizeTitles($in);
    if ($actual !== $expected) {
        fwrite(STDERR, "FAIL titles {$name}: got " . json_encode($actual, JSON_UNESCAPED_UNICODE) . "\n");
        $failures++;
    } else {
        echo "PASS titles {$name}\n";
    }
}

$statusCases = [
    'all done' => [['a', 'b'], [['title' => 'a', 'completed' => 1], ['title' => '↳ b', 'completed' => true]], true, ['a' => true, 'b' => true]],
    'one open' => [['a', 'b'], [['title' => 'a', 'completed' => 1], ['title' => 'b', 'completed' => 0]], false, ['a' => true, 'b' => false]],
    'missing item not done' => [['a', 'b'], [['title' => 'a', 'completed' => 1]], false, ['a' => true, 'b' => null]],
    'day not built' => [['a'], [], false, ['a' => null]],
    'duplicate needs every copy' => [['a'], [['title' => 'a', 'completed' => 1], ['title' => 'a', 'completed' => 0]], false, ['a' => false]],
    'other titles ignored' => [['a'], [['title' => 'secret', 'completed' => 0], ['title' => 'a', 'completed' => 1]], true, ['a' => true]],
    'no titles is never done' => [[], [], false, []],
];
foreach ($statusCases as $name => [$titles, $rows, $done, $items]) {
    $r = BoardService::summarisePublic($titles, $rows, '2026-11-02');
    if ($r !== ['day' => '2026-11-02', 'done' => $done, 'items' => $items]) {
        fwrite(STDERR, "FAIL status {$name}: " . json_encode($r, JSON_UNESCAPED_UNICODE) . "\n");
        $failures++;
    } else {
        echo "PASS status {$name}\n";
    }
}

foreach ([[null, []], ['', []], ['not json', []], ['{"a":1}', []], ['[" a ","↳ b","a"]', ['a', 'b']]] as [$in, $exp]) {
    if (BoardService::decodeTitles($in) !== $exp) {
        fwrite(STDERR, 'FAIL decodeTitles ' . var_export($in, true) . "\n");
        $failures++;
    } else {
        echo "PASS decodeTitles\n";
    }
}

exit($failures === 0 ? 0 : 1);
